import { createHash } from 'node:crypto';
import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage, LLMToolCall } from '../../llm/types';
import { withGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import { tokenCounter } from '../context/token-counter';
import type { LearningSystem } from '../learning/learning-system';
import { findingResponseSchema } from '../schema/finding-schema';
import { ToolRegistry } from '../tools/registry';
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

export interface SpecialistReviewOptions {
  scopePaths?: string[];
  allowTools?: boolean;
  maxIterations?: number;
  mode?: ReviewMode;
  maxContextTokens?: number;
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

export class SpecialistAgent {
  constructor(
    protected readonly gateway: LLMGateway,
    protected readonly category: FindingCategory,
    protected readonly agentName: string,
    protected readonly focusPrompt: string,
    protected readonly toolRegistry?: ToolRegistry,
    protected readonly learningSystem?: LearningSystem
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
            config.review.globalPrompt
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
        return { agentName: this.agentName, findings: [] };
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
    const findingsMap = new Map<string, Omit<Finding, 'id' | 'runId' | 'published'>>();
    const compactContext = toCompactContext(context, {
      scopePaths: options?.scopePaths,
      maxContextTokens: options?.maxContextTokens,
    });
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
1. 分析给定的代码变更
2. 如需更多信息，使用工具调查（如搜索相似代码、分析函数调用）
3. 基于证据报告问题

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
          config.review.globalPrompt
        ),
      },
    ];

    // 添加Few-shot示例（如果学习系统可用）
    if (this.learningSystem) {
      try {
        const fewShotExamples = await this.learningSystem.generateFewShotExamples(
          this.category,
          run.owner,
          run.repo
        );
        if (fewShotExamples.length > 0) {
          const llmFewShotExamples = fewShotExamples
            .map((msg) => {
              if (
                (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') &&
                typeof msg.content === 'string'
              ) {
                return { role: msg.role, content: msg.content } as const;
              }
              return null;
            })
            .filter(
              (msg): msg is { role: 'system' | 'user' | 'assistant'; content: string } =>
                msg !== null
            );

          messages.push(...llmFewShotExamples);
          logger.debug(`${this.agentName} 添加了 ${fewShotExamples.length} 条Few-shot示例`, {
            runId: run.id,
          });
        }
      } catch (error) {
        logger.warn(`${this.agentName} Few-shot示例生成失败`, {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 添加当前审查任务
    messages.push({
      role: 'user',
      content: `审查以下代码变更：\n${compactContext}`,
    });

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        logger.info(`${this.agentName} ReAct迭代 ${iteration + 1}/${maxIterations}`, {
          runId: run.id,
        });

        // 仅在最后一轮迭代强制 JSON 输出（无工具调用时解析结果）
        // 避免 response_format: json_object 与 tools 参数冲突导致工具不被调用
        const isLastIteration = iteration === maxIterations - 1;
        const response = await this.gateway.chatForRole('specialist', {
          messages,
          temperature: 0,
          tools: this.toolRegistry!.toToolDefinitions(),
          providerOptions: { tool_choice: isLastIteration ? 'none' : 'auto' },
          responseFormat: isLastIteration ? 'json' : undefined,
        });

        // 处理工具调用
        if (response.toolCalls.length > 0) {
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
          try {
            const parsed = JSON.parse(response.content);

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
          break;
        }
      }

      return { agentName: this.agentName, findings: Array.from(findingsMap.values()) };
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
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.toolRegistry!.get(toolCall.name);

      if (!tool) {
        results.push({
          toolCallId: toolCall.id,
          success: false,
          error: `工具 ${toolCall.name} 未找到`,
        });
        continue;
      }

      try {
        const params = JSON.parse(toolCall.arguments);
        const result = await tool.execute(params, context);

        logger.info(`工具调用成功: ${toolCall.name}`, {
          runId: context.runId,
          params,
        });

        results.push({
          toolCallId: toolCall.id,
          success: true,
          result,
        });
      } catch (error) {
        logger.error(`工具调用失败: ${toolCall.name}`, {
          runId: context.runId,
          error: error instanceof Error ? error.message : String(error),
        });

        results.push({
          toolCallId: toolCall.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
