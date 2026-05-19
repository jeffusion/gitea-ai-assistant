import { createHash } from 'node:crypto';
import { getKernelAgentContext } from '../../agent-kernel/agents/kernel-agent-context';
import type { KernelHookRegistry } from '../../agent-kernel/hooks/kernel-hook-registry';
import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage, LLMToolCall } from '../../llm/types';
import { mergeReviewPrompts, withGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import { tokenCounter } from '../context/token-counter';
import { findingResponseSchema } from '../schema/finding-schema';
import { ToolRegistry } from '../tools/registry';
import { runToolOrchestration } from '../tools/tool-orchestration';
import type { ToolExecutionContext, ToolResult } from '../tools/types';
import {
  AgentResult,
  Finding,
  FindingCategory,
  REVIEW_DEFAULT_BUDGETS,
  ReviewContext,
  ReviewRun,
  ReviewTask,
} from '../types';

export type AutonomousReviewState =
  | 'investigating'
  | 'tool_calling'
  | 'synthesizing'
  | 'finalizing'
  | 'completed'
  | 'failed';

interface AutonomousReviewDiagnostics {
  scopedPaths?: string[];
  compactContextTokens?: number;
  iterations: number;
  stateSequence: AutonomousReviewState[];
  stopReason?: string;
  toolCallNames: string[];
  toolCallCount: number;
  parsedFindingCount?: number;
  finalResponsePreview?: string;
  parseErrors: string[];
  emptyResponseCount: number;
  consecutiveToolFailures: number;
}

interface ResolvedBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxElapsedMs: number;
}

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(`${category}:${path}:${line}:${title}`)
    .digest('hex')
    .slice(0, 24);
}

function previewContent(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  return content.length > 2000 ? `${content.slice(0, 2000)}…` : content;
}

function resolveBudget(task: ReviewTask): ResolvedBudget {
  const defaults =
    task.mode === 'full' && task.reviewSize === 'large'
      ? REVIEW_DEFAULT_BUDGETS.largeFull
      : task.mode === 'full'
        ? REVIEW_DEFAULT_BUDGETS.full
        : REVIEW_DEFAULT_BUDGETS.light;

  return {
    maxTurns: Math.max(1, task.maxTurns ?? defaults.maxTurns),
    maxToolCalls: Math.max(0, task.maxToolCalls ?? defaults.maxToolCalls),
    maxElapsedMs: Math.max(1, task.maxElapsedMs ?? defaults.maxElapsedMs),
  };
}

function toCompactContext(context: ReviewContext, task: ReviewTask): string {
  const scopedPaths = task.suspectedEntrypoints?.length ? new Set(task.suspectedEntrypoints) : null;
  const scopedChangedFiles = scopedPaths
    ? context.changedFiles.filter((file) => scopedPaths.has(file.path))
    : context.changedFiles;
  const scopedParsedDiff = scopedPaths
    ? context.parsedDiff.filter((file) => scopedPaths.has(file.path))
    : context.parsedDiff;
  const scopedFileContents = scopedPaths
    ? Object.fromEntries(
        Object.entries(context.fileContents).filter(([filePath]) => scopedPaths.has(filePath))
      )
    : context.fileContents;

  const payload = JSON.stringify(
    {
      changedFiles: scopedChangedFiles,
      diffSnippets: scopedParsedDiff,
      fileContents: scopedFileContents,
    },
    null,
    2
  );

  return tokenCounter.count(payload) > task.tokenBudget
    ? tokenCounter.clip(payload, task.tokenBudget)
    : payload;
}

function buildSystemPrompt(toolRegistry?: ToolRegistry, projectPrompt?: string): string {
  const toolList = toolRegistry?.getAll().length
    ? toolRegistry
        .getAll()
        .map((tool) => `- ${tool.name}: ${tool.description}`)
        .join('\n')
    : '无可用工具。';

  return withGlobalPrompt(
    `你是 Claude Code/Codex 风格的自主代码审查代理。你负责完整审查本次变更，不按 correctness/security/quality 拆分任务。

可用工具：
${toolList}

工作规则：
1. 先调查，再结论。你可以自主选择 search_code、read_file 或其他工具，不要等待外部程序替你选文件。
2. 不要按文件孤立审查；需要跨文件确认 API 持久化、状态流、权限、错误分支、边界条件和相似实现。
3. 仅报告有明确证据、会导致真实功能/安全/可靠性问题的 finding。
4. 当需要更多信息时直接调用工具；当调查完成时输出最终 JSON：{"findings":[...]}。无问题返回 {"findings":[]}。
5. 每个 finding 必须包含 severity、confidence、path、line、title、detail、evidence、suggestion，可选 category 为 correctness/security/quality。`,
    mergeReviewPrompts(config.review.globalPrompt, projectPrompt)
  );
}

function buildUserPrompt(context: ReviewContext, task: ReviewTask, compactContext: string): string {
  const changedFiles = context.changedFiles
    .map(
      (file, index) =>
        `${index + 1}. ${file.path} (+${file.additions}/-${file.deletions}, ${file.status})`
    )
    .join('\n');

  return `审查任务：
- mode: ${task.mode}
- reviewSize: ${task.reviewSize ?? 'unknown'}
- riskTags: ${task.riskTags.length ? task.riskTags.join(', ') : 'none'}
- suspectedEntrypoints: ${task.suspectedEntrypoints?.length ? task.suspectedEntrypoints.join(', ') : 'none'}
- tokenBudget: ${task.tokenBudget}

变更文件清单：
${changedFiles || '无变更文件'}

请自主调查这些变更，模型自己决定是否调用工具以及调用哪些工具。不要只凭文件名或 diff 猜测；完成调查后输出最终 JSON。

压缩上下文：
${compactContext}`;
}

export class AutonomousReviewAgent {
  constructor(
    private readonly gateway: LLMGateway,
    private readonly toolRegistry?: ToolRegistry,
    private readonly hookRegistry?: KernelHookRegistry,
    private readonly agentName = 'AutonomousReviewAgent',
    private readonly projectPrompt?: string
  ) {}

  async review(run: ReviewRun, context: ReviewContext, task: ReviewTask): Promise<AgentResult> {
    if (!context.diff.trim() || task.mode === 'skip') {
      return { agentName: this.agentName, findings: [] };
    }

    const budget = resolveBudget(task);
    const startTime = Date.now();
    const compactContext = toCompactContext(context, task);
    const diagnostics: AutonomousReviewDiagnostics = {
      scopedPaths: task.suspectedEntrypoints,
      compactContextTokens: tokenCounter.count(compactContext),
      iterations: 0,
      stateSequence: [],
      toolCallNames: [],
      toolCallCount: 0,
      parseErrors: [],
      emptyResponseCount: 0,
      consecutiveToolFailures: 0,
    };
    const messages: LLMMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.toolRegistry, this.projectPrompt) },
      { role: 'user', content: buildUserPrompt(context, task, compactContext) },
    ];

    let finalAnswer: string | undefined;
    const transition = (next: AutonomousReviewState) => {
      diagnostics.stateSequence.push(next);
    };

    try {
      while (true) {
        if (Date.now() - startTime >= budget.maxElapsedMs) {
          diagnostics.stopReason = 'maxElapsedMs';
          transition('synthesizing');
          finalAnswer = await this.synthesizeFinalAnswer(messages, diagnostics);
          transition('finalizing');
          break;
        }
        if (diagnostics.iterations >= budget.maxTurns) {
          diagnostics.stopReason = 'maxTurns';
          transition('synthesizing');
          finalAnswer = await this.synthesizeFinalAnswer(messages, diagnostics);
          transition('finalizing');
          break;
        }
        if (diagnostics.toolCallCount >= budget.maxToolCalls) {
          diagnostics.stopReason = 'maxToolCalls';
          transition('synthesizing');
          finalAnswer = await this.synthesizeFinalAnswer(messages, diagnostics);
          transition('finalizing');
          break;
        }
        if (diagnostics.emptyResponseCount >= 2) {
          diagnostics.stopReason = 'emptyResponses';
          transition('synthesizing');
          finalAnswer = await this.synthesizeFinalAnswer(messages, diagnostics);
          transition('finalizing');
          break;
        }
        if (diagnostics.consecutiveToolFailures >= 3) {
          diagnostics.stopReason = 'toolFailures';
          transition('synthesizing');
          finalAnswer = await this.synthesizeFinalAnswer(messages, diagnostics);
          transition('finalizing');
          break;
        }

        transition('investigating');
        diagnostics.iterations += 1;
        const response = await this.gateway.chatForRole('specialist', {
          messages,
          temperature: 0,
          tools: this.toolRegistry?.getAll().length
            ? this.toolRegistry.toToolDefinitions()
            : undefined,
        });

        if (response.toolCalls.length > 0) {
          const allowedToolCalls = response.toolCalls.slice(
            0,
            Math.max(0, budget.maxToolCalls - diagnostics.toolCallCount)
          );
          diagnostics.toolCallNames.push(...allowedToolCalls.map((toolCall) => toolCall.name));
          diagnostics.toolCallCount += allowedToolCalls.length;
          messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: allowedToolCalls,
          });

          transition('tool_calling');
          const toolResults = await this.executeTools(allowedToolCalls, {
            workspacePath: context.workspacePath,
            mirrorPath: context.mirrorPath,
            runId: run.id,
          });
          const failures = toolResults.filter((toolResult) => !toolResult.success).length;
          diagnostics.consecutiveToolFailures =
            failures > 0 ? diagnostics.consecutiveToolFailures + failures : 0;

          for (const toolResult of toolResults) {
            messages.push({
              role: 'tool',
              toolCallId: toolResult.toolCallId,
              content: JSON.stringify(toolResult.result || { error: toolResult.error }),
            });
          }
          continue;
        }

        if (!response.content?.trim()) {
          diagnostics.emptyResponseCount += 1;
          messages.push({
            role: 'assistant',
            content: '',
          });
          continue;
        }

        diagnostics.stopReason = 'modelFinalized';
        finalAnswer = response.content;
        diagnostics.finalResponsePreview = previewContent(finalAnswer);
        transition('finalizing');
        break;
      }

      const findings = await this.finalizeFindings(
        messages,
        finalAnswer ?? '{"findings":[]}',
        diagnostics
      );
      diagnostics.parsedFindingCount = findings.length;
      transition('completed');
      return {
        agentName: this.agentName,
        findings,
        diagnostics,
      };
    } catch (error) {
      transition('failed');
      logger.error(`${this.agentName} 执行失败`, {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { agentName: this.agentName, findings: [], diagnostics };
    }
  }

  private async synthesizeFinalAnswer(
    messages: LLMMessage[],
    diagnostics: AutonomousReviewDiagnostics
  ): Promise<string> {
    messages.push({
      role: 'user',
      content:
        '你已达到停止条件。请基于现有调查证据输出最终 JSON：{"findings":[...]}。不要调用工具，不要输出额外文字。',
    });
    const response = await this.gateway.chatForRole('specialist', {
      messages,
      temperature: 0,
      responseFormat: 'json',
    });
    const content = response.content || '{"findings":[]}';
    diagnostics.finalResponsePreview = previewContent(content);
    messages.push({ role: 'assistant', content });
    return content;
  }

  private async finalizeFindings(
    messages: LLMMessage[],
    content: string,
    diagnostics: AutonomousReviewDiagnostics
  ): Promise<Omit<Finding, 'id' | 'runId' | 'published'>[]> {
    let current = content;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const parsed = findingResponseSchema.parse(JSON.parse(current));
        return parsed.findings.map((item) => {
          const category: FindingCategory = item.category ?? 'correctness';
          return {
            ...item,
            category,
            fingerprint:
              item.fingerprint || buildFingerprint(category, item.path, item.line, item.title),
          };
        });
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        diagnostics.parseErrors.push(message);
        if (attempt === 2) {
          throw parseError;
        }
        messages.push({ role: 'assistant', content: current });
        messages.push({
          role: 'user',
          content:
            '上一次最终结果无法通过 findingResponseSchema。请修复为严格 JSON：{"findings":[{"severity":"high|medium|low","confidence":0.0,"path":"...","line":1,"title":"...","detail":"...","evidence":"...","suggestion":"..."}]}。不要输出额外文字。',
        });
        const repair = await this.gateway.chatForRole('specialist', {
          messages,
          temperature: 0,
          responseFormat: 'json',
        });
        current = repair.content || '{"findings":[]}';
        diagnostics.finalResponsePreview = previewContent(current);
      }
    }

    return [];
  }

  private async executeTools(
    toolCalls: LLMToolCall[],
    context: ToolExecutionContext
  ): Promise<ToolResult[]> {
    if (!this.toolRegistry || toolCalls.length === 0) {
      return [];
    }

    const agentContext = getKernelAgentContext();
    const orchestration = await runToolOrchestration({
      registry: this.toolRegistry,
      toolCalls,
      context: {
        ...context,
        agentName: this.agentName,
        agentId: agentContext?.agentId,
        source: 'react',
      },
      hookRegistry: this.hookRegistry,
    });

    return orchestration.results;
  }
}
