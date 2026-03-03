import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { logger } from '../../utils/logger';
import type { LearningSystem } from '../learning/learning-system';
import { findingResponseSchema } from '../schema/finding-schema';
import { ToolRegistry } from '../tools/registry';
import type { ToolExecutionContext, ToolResult } from '../tools/types';
import { AgentResult, Finding, FindingCategory, ReviewContext, ReviewRun } from '../types';

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(`${category}:${path}:${line}:${title}`)
    .digest('hex')
    .slice(0, 24);
}

function toCompactContext(context: ReviewContext): string {
  // 全局上下文大小限制：100k chars（约33k tokens），为系统prompt、few-shot、响应留空间
  const MAX_CONTEXT_CHARS = 100_000;

  const files = context.changedFiles.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));

  // 策略：逐步缩减直到满足限制
  // 1. changedFiles元数据（小且必需）
  // 2. parsedDiff（关键，逐步减少每个文件的changes数量）
  // 3. fileContents（最大，按需截断或移除部分文件）

  let maxChangesPerFile = 200;
  let maxFileContentsEntries = Object.keys(context.fileContents).length;

  // 尝试构建并测量大小
  const tryBuild = (changesLimit: number, contentEntriesLimit: number): string => {
    const snippets = context.parsedDiff.map((file) => ({
      path: file.path,
      changes: file.changes.slice(0, changesLimit),
    }));

    const limitedContents: Record<string, string> = {};
    const contentKeys = Object.keys(context.fileContents);
    for (let i = 0; i < Math.min(contentEntriesLimit, contentKeys.length); i++) {
      const key = contentKeys[i];
      limitedContents[key] = context.fileContents[key];
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

  // 如果超过限制，逐步缩减
  while (
    result.length > MAX_CONTEXT_CHARS &&
    (maxChangesPerFile > 20 || maxFileContentsEntries > 0)
  ) {
    if (maxChangesPerFile > 20) {
      maxChangesPerFile = Math.max(20, Math.floor(maxChangesPerFile * 0.7));
    } else if (maxFileContentsEntries > 0) {
      maxFileContentsEntries = Math.max(0, Math.floor(maxFileContentsEntries * 0.5));
    }

    result = tryBuild(maxChangesPerFile, maxFileContentsEntries);
  }

  // 如果仍然超限，强制截断（保留前N个字符）
  if (result.length > MAX_CONTEXT_CHARS) {
    logger.warn('Context size still exceeds limit after reduction, truncating', {
      originalSize: result.length,
      limit: MAX_CONTEXT_CHARS,
    });
    result = `${result.slice(0, MAX_CONTEXT_CHARS)}\n... [truncated]`;
  }

  return result;
}

export class SpecialistAgent {
  constructor(
    protected readonly openai: OpenAI,
    protected readonly model: string,
    protected readonly category: FindingCategory,
    protected readonly agentName: string,
    protected readonly focusPrompt: string,
    protected readonly toolRegistry?: ToolRegistry,
    protected readonly learningSystem?: LearningSystem
  ) {}

  async review(run: ReviewRun, context: ReviewContext): Promise<AgentResult> {
    if (!context.diff.trim()) {
      return { agentName: this.agentName, findings: [] };
    }

    // 如果没有工具注册表，使用传统单次调用模式
    if (!this.toolRegistry || this.toolRegistry.getAll().length === 0) {
      return this.reviewLegacy(run, context);
    }

    // ReAct循环模式
    return this.reviewWithReAct(run, context);
  }

  private async reviewLegacy(run: ReviewRun, context: ReviewContext): Promise<AgentResult> {
    const prompt = `你是${this.agentName}，只关注${this.focusPrompt}。
输出必须是JSON对象格式: {"findings": []}。
仅报告有明确证据的问题；无问题时返回空数组。

审查上下文如下:
${toCompactContext(context)}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是严格的代码审查专家。返回结构化JSON，不输出额外文字。confidence取值范围0到1。line必须是正整数且引用新增行。',
          },
          { role: 'user', content: prompt },
        ],
      });

      const content = response.choices[0]?.message.content;
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

  private async reviewWithReAct(run: ReviewRun, context: ReviewContext): Promise<AgentResult> {
    const maxIterations = 5;
    const findingsMap = new Map<string, Omit<Finding, 'id' | 'runId' | 'published'>>();
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `你是${this.agentName}，专注于${this.focusPrompt}。

你可以使用以下工具进行深入调查：
${this.toolRegistry!.getAll()
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n')}

工作流程：
1. 分析给定的代码变更
2. 如需更多信息，使用工具调查（如搜索相似代码、分析函数调用）
3. 基于证据报告问题

当你需要使用工具时，直接调用工具即可。
当你完成所有调查并准备输出最终结果时，以纯JSON格式返回：
{"findings": [...], "need_more_investigation": false}
confidence取值范围0到1。line必须是正整数且引用新增行。`,
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
          messages.push(...fewShotExamples);
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
      content: `审查以下代码变更：\n${toCompactContext(context)}`,
    });

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        logger.info(`${this.agentName} ReAct迭代 ${iteration + 1}/${maxIterations}`, {
          runId: run.id,
        });

        // 仅在最后一轮迭代强制 JSON 输出（无工具调用时解析结果）
        // 避免 response_format: json_object 与 tools 参数冲突导致工具不被调用
        const isLastIteration = iteration === maxIterations - 1;
        const response = await this.openai.chat.completions.create({
          model: this.model,
          temperature: 0,
          ...(isLastIteration ? { response_format: { type: 'json_object' as const } } : {}),
          messages,
          tools: this.toolRegistry!.toOpenAIFunctions(),
          tool_choice: isLastIteration ? 'none' : 'auto',
        });

        const choice = response.choices[0];
        if (!choice) break;

        // 处理工具调用
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          messages.push(choice.message as OpenAI.Chat.ChatCompletionMessageParam);

          // 执行所有工具调用
          const toolResults = await this.executeTools(choice.message.tool_calls, {
            workspacePath: context.workspacePath,
            mirrorPath: context.mirrorPath,
            runId: run.id,
          });

          // 添加工具结果到对话
          for (const toolResult of toolResults) {
            messages.push({
              role: 'tool',
              tool_call_id: toolResult.toolCallId,
              content: JSON.stringify(toolResult.result || { error: toolResult.error }),
            });
          }

          continue; // 继续下一轮
        }

        // 解析findings（模型选择返回内容而非调用工具）
        if (choice.message.content) {
          try {
            const parsed = JSON.parse(choice.message.content);

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
            messages.push(choice.message as OpenAI.Chat.ChatCompletionMessageParam);
            messages.push({
              role: 'user',
              content:
                '请使用工具进行更深入的调查。如果你已经获得了足够的信息，请将 need_more_investigation 设为 false 并输出最终结果。',
            });
          } catch (parseError) {
            logger.error(`${this.agentName} 解析响应失败`, {
              runId: run.id,
              error: parseError instanceof Error ? parseError.message : String(parseError),
            });
            break;
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
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    context: ToolExecutionContext
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.toolRegistry!.get(toolCall.function.name);

      if (!tool) {
        results.push({
          toolCallId: toolCall.id,
          success: false,
          error: `工具 ${toolCall.function.name} 未找到`,
        });
        continue;
      }

      try {
        const params = JSON.parse(toolCall.function.arguments);
        const result = await tool.execute(params, context);

        logger.info(`工具调用成功: ${toolCall.function.name}`, {
          runId: context.runId,
          params,
        });

        results.push({
          toolCallId: toolCall.id,
          success: true,
          result,
        });
      } catch (error) {
        logger.error(`工具调用失败: ${toolCall.function.name}`, {
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
