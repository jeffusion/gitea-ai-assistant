import { modelRoleRepo } from '../../db/repositories/model-role-repo';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage } from '../../llm/types';
import { withCoreGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import { tokenCounter } from '../context/token-counter';
import type { ReviewContext } from '../types';

export interface CompressedReviewContext {
  summary: string;
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  triggerThreshold: number;
  model: string;
  compressedAt: string;
}

const AUTOCOMPACT_TRIGGER_RATIO = 0.8;

function buildCompressionSource(context: ReviewContext): string {
  const fileSummary = context.changedFiles
    .map((file) => `${file.status} ${file.path} (+${file.additions} -${file.deletions})`)
    .join('\n');

  const diffPreview = context.diff.slice(0, 20_000);
  const fileContentsPreview = Object.entries(context.fileContents)
    .slice(0, 12)
    .map(([path, content]) => `## ${path}\n${content.slice(0, 2500)}`)
    .join('\n\n');

  return [
    '变更文件：',
    fileSummary,
    '',
    'Diff 预览：',
    diffPreview,
    '',
    '文件内容摘录：',
    fileContentsPreview,
  ].join('\n');
}

export class ContextCompressionService {
  constructor(private readonly gateway: LLMGateway) {}

  getPlannerCompressionThreshold(): number {
    const assignment = modelRoleRepo.getByRole('planner');
    if (!assignment) {
      return Math.floor(128_000 * AUTOCOMPACT_TRIGGER_RATIO);
    }
    return Math.floor(tokenCounter.getContextWindow(assignment.model) * AUTOCOMPACT_TRIGGER_RATIO);
  }

  shouldCompress(context: ReviewContext, existing?: CompressedReviewContext): boolean {
    if (existing?.summary) {
      return false;
    }

    const source = buildCompressionSource(context);
    return tokenCounter.count(source) >= this.getPlannerCompressionThreshold();
  }

  async compress(context: ReviewContext, projectPrompt?: string): Promise<CompressedReviewContext> {
    const assignment = modelRoleRepo.getByRole('planner');
    const model = assignment?.model ?? 'planner';
    const triggerThreshold = this.getPlannerCompressionThreshold();
    const source = buildCompressionSource(context);
    const sourceTokenEstimate = tokenCounter.count(source);

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: withCoreGlobalPrompt(
          `你是 kernel agent 的上下文压缩器。你的职责是把超大代码审查上下文压缩为后续 subagent 可复用的高保真摘要。

输出要求：
- 只输出 JSON
- 保留对后续审查真正关键的信息
- 不要复述无关噪音

返回格式：
{
  "summary": "Markdown 摘要，必须包含以下小节：Change Overview、High-Risk Areas、Important Files、Open Questions、Recommended Focus"
}`,
          projectPrompt,
          8_000
        ),
      },
      {
        role: 'user',
        content: `请压缩下面的代码审查上下文，供后续 triage / specialist subagents 使用：\n\n${source}`,
      },
    ];

    const response = await this.gateway.chatForRole('planner', {
      messages,
      temperature: 0,
      responseFormat: 'json',
      maxTokens: 2_000,
    });

    const raw = response.content;
    if (!raw) {
      throw new Error('Context compression returned empty content');
    }

    const parsed = JSON.parse(raw) as { summary?: string };
    const summary = parsed.summary?.trim();
    if (!summary) {
      throw new Error('Context compression summary is empty');
    }

    const summaryTokenEstimate = tokenCounter.count(summary);

    logger.info('Kernel 上下文压缩完成', {
      sourceTokenEstimate,
      summaryTokenEstimate,
      triggerThreshold,
      compressionRatio: Number((summaryTokenEstimate / sourceTokenEstimate).toFixed(3)),
      model,
    });

    return {
      summary,
      sourceTokenEstimate,
      summaryTokenEstimate,
      triggerThreshold,
      model,
      compressedAt: new Date().toISOString(),
    };
  }
}
