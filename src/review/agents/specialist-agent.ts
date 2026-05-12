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
  ReviewContext,
  ReviewMode,
  ReviewRun,
} from '../types';

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(`${category}:${path}:${line}:${title}`)
    .digest('hex')
    .slice(0, 24);
}

interface CompactContextOptions {
  scopePaths?: string[];
  maxContextTokens?: number;
}

interface SpecialistDiagnostics {
  scopedPaths?: string[];
  compactContextTokens?: number;
  iterations?: number;
  toolCallNames?: string[];
  forcedToolChoiceCount?: number;
  parsedFindingCount?: number;
  finalResponsePreview?: string;
  parseErrors?: string[];
  emptyResponseCount?: number;
}

export interface SpecialistReviewOptions {
  scopePaths?: string[];
  allowTools?: boolean;
  maxIterations?: number;
  mode?: ReviewMode;
  maxContextTokens?: number;
  projectPrompt?: string;
  contextSummary?: string;
}

function toCompactContext(context: ReviewContext, options?: CompactContextOptions): string {
  const MAX_CONTEXT_TOKENS = options?.maxContextTokens ?? 25_000;

  const scopedPaths = options?.scopePaths ? new Set(options.scopePaths) : null;

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

  const files = scopedChangedFiles.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));

  // 策略：逐步缩减直到满足 token 限制
  // 1. changedFiles元数据（小且必需）
  // 2. parsedDiff（关键，逐步减少每个文件的changes数量）
  // 3. fileContents（最大，按需截断或移除部分文件）

  let maxChangesPerFile = 200;
  let maxFileContentsEntries = Object.keys(scopedFileContents).length;

  const tryBuild = (changesLimit: number, contentEntriesLimit: number): string => {
    const snippets = scopedParsedDiff.map((file) => ({
      path: file.path,
      changes: file.changes.slice(0, changesLimit),
    }));

    const limitedContents: Record<string, string> = {};
    const contentKeys = Object.keys(scopedFileContents);
    for (let i = 0; i < Math.min(contentEntriesLimit, contentKeys.length); i++) {
      const key = contentKeys[i];
      limitedContents[key] = scopedFileContents[key];
    }

    return JSON.stringify(
      {
        changedFiles: files,
        diffSnippets: snippets,
        fileContents: limitedContents,
      },
      null,
      2
    );
  };

  let result = tryBuild(maxChangesPerFile, maxFileContentsEntries);

  // 如果超过 token 限制，逐步缩减
  while (
    tokenCounter.count(result) > MAX_CONTEXT_TOKENS &&
    (maxChangesPerFile > 20 || maxFileContentsEntries > 0)
  ) {
    if (maxChangesPerFile > 20) {
      maxChangesPerFile = Math.max(20, Math.floor(maxChangesPerFile * 0.7));
    } else if (maxFileContentsEntries > 0) {
      maxFileContentsEntries = Math.max(0, Math.floor(maxFileContentsEntries * 0.5));
    }

    result = tryBuild(maxChangesPerFile, maxFileContentsEntries);
  }

  // 如果仍然超限，强制截断
  if (tokenCounter.count(result) > MAX_CONTEXT_TOKENS) {
    logger.warn('Context size still exceeds token limit after reduction, truncating', {
      estimatedTokens: tokenCounter.count(result),
      limit: MAX_CONTEXT_TOKENS,
    });
    result = tokenCounter.clip(result, MAX_CONTEXT_TOKENS);
  }

  return result;
}

function buildChangedFileChecklist(
  context: ReviewContext,
  options?: CompactContextOptions
): string {
  const scopedPaths = options?.scopePaths ? new Set(options.scopePaths) : null;
  const files = (
    scopedPaths
      ? context.changedFiles.filter((file) => scopedPaths.has(file.path))
      : context.changedFiles
  ).map((file) => `${file.path} (+${file.additions}/-${file.deletions}, ${file.status})`);

  if (files.length === 0) {
    return '本轮没有匹配到变更文件。';
  }

  return files.map((file, index) => `${index + 1}. ${file}`).join('\n');
}

function buildReviewQualityInstruction(
  context: ReviewContext,
  options?: CompactContextOptions
): string {
  return `以下是本轮 PR 的变更文件清单。它是调查地图，不是拆分任务；你必须自主决定先读哪些文件、哪些函数、哪些调用链，并保留跨文件关联判断：
${buildChangedFileChecklist(context, options)}

重点检查会导致真实功能错误的问题，尤其是：
- 新增/删除/编辑类 UI 操作是否真正调用后端 API 持久化，而不是只修改前端数组或临时状态；
- 表单提交是否和界面当前展示/预览的数据一致，是否可能提交额外或错误的数据；
- 去重、编号、边界条件、空值、权限、错误处理是否和已有业务规则一致；
- 新增大文件中的核心 CRUD 路径、watch/onMounted 副作用、异步失败分支是否闭环。

像 Codex review 一样工作：先从 diff 找风险点，再用 read_file/search_code 自主读取相关片段、上下游调用和相似实现。不要按文件孤立审查；涉及 UI 状态、API 持久化、列表刷新、跨组件事件时必须串起来判断。只有完成必要调查后仍无可执行问题，才返回空 findings。`;
}

function previewContent(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  return content.length > 2000 ? `${content.slice(0, 2000)}…` : content;
}

function buildReviewToolChoice(params: {
  mode?: ReviewMode;
  hasReadFile: boolean;
  isLastIteration: boolean;
  availableToolNames: string[];
}): unknown {
  if (params.isLastIteration) {
    return 'none';
  }

  if (
    params.mode === 'full' &&
    !params.hasReadFile &&
    params.availableToolNames.includes('read_file')
  ) {
    return { type: 'function', function: { name: 'read_file' } };
  }

  return 'auto';
}

export class SpecialistAgent {
  constructor(
    protected readonly gateway: LLMGateway,
    protected readonly category: FindingCategory,
    protected readonly agentName: string,
    protected readonly focusPrompt: string,
    protected readonly toolRegistry?: ToolRegistry,
    protected readonly hookRegistry?: KernelHookRegistry
  ) {}

  async review(run: ReviewRun, context: ReviewContext): Promise<AgentResult> {
    return this.reviewWithOptions(run, context);
  }

  async reviewWithOptions(
    run: ReviewRun,
    context: ReviewContext,
    options?: SpecialistReviewOptions
  ): Promise<AgentResult> {
    if (!context.diff.trim()) {
      return { agentName: this.agentName, findings: [] };
    }

    if (options?.mode === 'skip') {
      return { agentName: this.agentName, findings: [] };
    }

    if (
      !this.toolRegistry ||
      this.toolRegistry.getAll().length === 0 ||
      options?.allowTools === false
    ) {
      return this.reviewSinglePass(run, context, options);
    }

    // ReAct循环模式
    return this.reviewWithReAct(run, context, options);
  }

  private async reviewSinglePass(
    run: ReviewRun,
    context: ReviewContext,
    options?: SpecialistReviewOptions
  ): Promise<AgentResult> {
    const prompt = `你是${this.agentName}，只关注${this.focusPrompt}。
输出必须是JSON对象格式:
{"findings": [{"severity": "high"|"medium"|"low", "confidence": 0-1, "path": "文件路径", "line": 正整数, "title": "标题", "detail": "详情", "evidence": "证据", "suggestion": "建议"}]}
每个 finding 的所有字段都是必填的。仅报告有明确证据的问题；无问题时返回空数组。

${buildReviewQualityInstruction(context, options)}

${options?.contextSummary ? `压缩上下文摘要（优先参考历史信息）：\n${options.contextSummary}\n` : ''}

审查上下文如下:
${toCompactContext(context, {
  scopePaths: options?.scopePaths,
  maxContextTokens: options?.maxContextTokens,
})}`;

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: withGlobalPrompt(
            '你是严格的代码审查专家。返回结构化JSON，不输出额外文字。confidence取值范围0到1。line必须是正整数且引用新增行。',
            mergeReviewPrompts(config.review.globalPrompt, options?.projectPrompt)
          ),
        },
        { role: 'user', content: prompt },
      ];

      const response = await this.gateway.chatForRole('specialist', {
        messages,
        temperature: 0,
        responseFormat: 'json',
      });

      const content = response.content;
      if (!content) {
        return {
          agentName: this.agentName,
          findings: [],
          diagnostics: { emptyResponseCount: 1 },
        };
      }

      const parsed = findingResponseSchema.parse(JSON.parse(content));
      const findings = parsed.findings.map((item) => ({
        ...item,
        category: this.category,
        fingerprint:
          item.fingerprint || buildFingerprint(this.category, item.path, item.line, item.title),
      }));

      return {
        agentName: this.agentName,
        findings,
        diagnostics: {
          scopedPaths: options?.scopePaths,
          compactContextTokens: tokenCounter.count(prompt),
          iterations: 1,
          parsedFindingCount: findings.length,
          finalResponsePreview: previewContent(content),
        },
      };
    } catch (error) {
      logger.error(`${this.agentName} 执行失败`, {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { agentName: this.agentName, findings: [] };
    }
  }

  private async reviewWithReAct(
    run: ReviewRun,
    context: ReviewContext,
    options?: SpecialistReviewOptions
  ): Promise<AgentResult> {
    const maxIterations = Math.max(
      1,
      options?.maxIterations ?? (options?.mode === 'light' ? 1 : 2)
    );
    const maxTurns = options?.mode === 'full' ? maxIterations + 2 : maxIterations;
    const findingsMap = new Map<string, Omit<Finding, 'id' | 'runId' | 'published'>>();
    const compactContext = toCompactContext(context, {
      scopePaths: options?.scopePaths,
      maxContextTokens: options?.maxContextTokens,
    });
    const diagnostics: SpecialistDiagnostics = {
      scopedPaths: options?.scopePaths,
      compactContextTokens: tokenCounter.count(compactContext),
      iterations: 0,
      toolCallNames: [],
      parseErrors: [],
      emptyResponseCount: 0,
      forcedToolChoiceCount: 0,
    };
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: withGlobalPrompt(
          `你是${this.agentName}，专注于${this.focusPrompt}。

你可以使用以下工具进行深入调查：
${this.toolRegistry!.getAll()
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n')}

工作流程：
1. 先从 diff 和变更文件清单识别风险点，自主决定需要读取哪些文件、函数片段和上下游调用。
2. 不要按文件孤立审查；涉及 UI 状态、API 持久化、列表刷新、跨组件事件时必须串起来判断。
3. 对新增/删除/编辑类 UI 操作，必须确认是否调用后端 API 持久化；只修改本地数组/临时状态属于高优先级问题。
4. 如需更多信息，使用工具调查（如读取完整文件、搜索相似代码、分析函数调用）。
5. 基于证据报告会导致真实功能错误的问题；不要因为没有崩溃或语法错误就返回空结果。

当你需要使用工具时，直接调用工具即可。
当你完成所有调查并准备输出最终结果时，以纯JSON格式返回（不要包含任何额外文字）：
{
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "confidence": 0.0 到 1.0 之间的数字,
      "path": "文件路径",
      "line": 正整数，引用新增行的行号,
      "title": "问题简短标题",
      "detail": "问题详细描述",
      "evidence": "相关代码片段或证据",
      "suggestion": "修复建议"
    }
  ],
  "need_more_investigation": false
}
每个 finding 对象的所有字段都是必填的。无问题时返回空数组 {"findings": [], "need_more_investigation": false}。`,
          mergeReviewPrompts(config.review.globalPrompt, options?.projectPrompt)
        ),
      },
    ];

    // 添加当前审查任务
    messages.push({
      role: 'user',
      content: `${options?.contextSummary ? `压缩上下文摘要：\n${options.contextSummary}\n\n` : ''}${buildReviewQualityInstruction(context, options)}\n\n审查以下代码变更：\n${compactContext}`,
    });

    try {
      for (let iteration = 0; iteration < maxTurns; iteration++) {
        diagnostics.iterations = iteration + 1;
        logger.info(`${this.agentName} ReAct迭代 ${iteration + 1}/${maxTurns}`, {
          runId: run.id,
        });

        // 仅在最后一轮迭代强制 JSON 输出（无工具调用时解析结果）
        // 避免 response_format: json_object 与 tools 参数冲突导致工具不被调用
        const hasReadFile = diagnostics.toolCallNames?.includes('read_file') ?? false;
        const availableToolNames = this.toolRegistry!.getAll().map((tool) => tool.name);
        const canReadFile = availableToolNames.includes('read_file');
        const isFullModeReadyToSummarize =
          options?.mode === 'full' && (!canReadFile || hasReadFile) && iteration > 0;
        const isDefaultModeReadyToSummarize =
          options?.mode !== 'full' && iteration >= maxIterations - 1;
        const isLastIteration =
          isFullModeReadyToSummarize || isDefaultModeReadyToSummarize || iteration === maxTurns - 1;
        const toolChoice = buildReviewToolChoice({
          mode: options?.mode,
          hasReadFile,
          isLastIteration,
          availableToolNames,
        });
        if (toolChoice !== 'auto' && toolChoice !== 'none') {
          diagnostics.forcedToolChoiceCount = (diagnostics.forcedToolChoiceCount ?? 0) + 1;
        }

        const response = await this.gateway.chatForRole('specialist', {
          messages,
          temperature: 0,
          tools: this.toolRegistry!.toToolDefinitions(),
          providerOptions: { tool_choice: toolChoice },
          responseFormat: isLastIteration ? 'json' : undefined,
        });

        // 处理工具调用
        if (response.toolCalls.length > 0) {
          diagnostics.toolCallNames?.push(...response.toolCalls.map((toolCall) => toolCall.name));
          messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: response.toolCalls,
          });

          // 执行所有工具调用
          const toolResults = await this.executeTools(response.toolCalls, {
            workspacePath: context.workspacePath,
            mirrorPath: context.mirrorPath,
            runId: run.id,
          });

          // 添加工具结果到对话
          for (const toolResult of toolResults) {
            messages.push({
              role: 'tool',
              toolCallId: toolResult.toolCallId,
              content: JSON.stringify(toolResult.result || { error: toolResult.error }),
            });
          }

          continue; // 继续下一轮
        }

        // 解析findings（模型选择返回内容而非调用工具）
        if (response.content) {
          diagnostics.finalResponsePreview = previewContent(response.content);
          try {
            const parsed = JSON.parse(response.content);

            if (
              options?.mode === 'full' &&
              canReadFile &&
              !(diagnostics.toolCallNames?.includes('read_file') ?? false) &&
              iteration < maxTurns - 1
            ) {
              messages.push({
                role: 'assistant',
                content: response.content,
              });
              messages.push({
                role: 'user',
                content:
                  '你还没有读取任何文件内容。full 模式下不能基于整体 diff 直接输出最终结论；请调用 read_file 读取最可疑的文件片段，并在必要时继续 search_code 或 search_function_references。完成调查后再输出最终 JSON。',
              });
              continue;
            }

            if (parsed.findings && parsed.findings.length > 0) {
              // 使用schema验证findings，防止畸形数据流入发布系统
              const validated = findingResponseSchema.parse({ findings: parsed.findings });
              for (const item of validated.findings) {
                const fp =
                  item.fingerprint ||
                  buildFingerprint(this.category, item.path, item.line, item.title);
                // 基于 fingerprint 去重：后续迭代产生的同一 finding 覆盖前一次
                findingsMap.set(fp, {
                  ...item,
                  category: this.category,
                  fingerprint: fp,
                });
              }
              diagnostics.parsedFindingCount = findingsMap.size;
            }

            const noFindings = !parsed.findings || parsed.findings.length === 0;
            if (
              noFindings &&
              options?.mode === 'full' &&
              !(diagnostics.toolCallNames?.includes('read_file') ?? false) &&
              iteration < maxTurns - 1
            ) {
              messages.push({
                role: 'assistant',
                content: response.content,
              });
              messages.push({
                role: 'user',
                content:
                  '你还没有读取任何文件内容。full 模式下不能仅凭搜索或整体 diff 返回空 findings。请自主选择最可疑的文件和函数，调用 read_file 读取相关片段；如果涉及跨文件关系，也可继续 search_code。完成调查后再输出最终 JSON。',
              });
              continue;
            }

            // 判断是否需要继续调查
            if (!parsed.need_more_investigation) {
              break;
            }

            // 模型要求继续调查但没有调用工具：注入 user 消息打破潜在的自我重复
            messages.push({
              role: 'assistant',
              content: response.content,
            });
            messages.push({
              role: 'user',
              content:
                '请使用工具进行更深入的调查。如果你已经获得了足够的信息，请将 need_more_investigation 设为 false 并输出最终结果。',
            });
          } catch (parseError) {
            // 模型返回了非 JSON 文本（如中文自然语言），不应直接放弃
            // 将其作为对话上下文保留，提示模型返回 JSON 格式
            logger.warn(`${this.agentName} 响应非 JSON 格式，尝试引导模型返回 JSON`, {
              runId: run.id,
              error: parseError instanceof Error ? parseError.message : String(parseError),
            });
            diagnostics.parseErrors?.push(
              parseError instanceof Error ? parseError.message : String(parseError)
            );
            messages.push({
              role: 'assistant',
              content: response.content,
            });
            messages.push({
              role: 'user',
              content:
                '你的上一次响应不是有效的 JSON。请以纯 JSON 格式返回结果：{"findings": [...], "need_more_investigation": false}。不要包含任何额外文字。',
            });
          }
        } else {
          // 没有内容，结束循环
          diagnostics.emptyResponseCount = (diagnostics.emptyResponseCount ?? 0) + 1;
          break;
        }
      }

      diagnostics.parsedFindingCount = findingsMap.size;
      return {
        agentName: this.agentName,
        findings: Array.from(findingsMap.values()),
        diagnostics,
      };
    } catch (error) {
      logger.error(`${this.agentName} ReAct执行失败`, {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { agentName: this.agentName, findings: [] };
    }
  }

  private async executeTools(
    toolCalls: LLMToolCall[],
    context: ToolExecutionContext
  ): Promise<ToolResult[]> {
    const agentContext = getKernelAgentContext();
    const orchestration = await runToolOrchestration({
      registry: this.toolRegistry!,
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
