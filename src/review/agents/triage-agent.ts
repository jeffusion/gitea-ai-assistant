/**
 * Triage Agent — lightweight intent recognition using the 'planner' model role.
 *
 * Analyzes the change summary (file list + basic stats) to determine review
 * planning hints for the autonomous review loop.
 *
 * This avoids wasting tokens by running deep review on trivial changes
 * (e.g. README typo fixes, string-only edits, pure documentation changes).
 */

import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage } from '../../llm/types';
import { mergeReviewPrompts, withCoreGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import type {
  ChangedFile,
  ReviewBudgetPolicy,
  ReviewContext,
  ReviewExecutionBudget,
  ReviewMode,
  ReviewSize,
} from '../types';
import { REVIEW_DEFAULT_BUDGETS } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriageBudgetHints extends ReviewExecutionBudget {
  tokenBudget: number;
}

export interface TriageChangedFileSummary {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: string[];
}

export interface TriageResult {
  reviewSize: ReviewSize;
  mode: ReviewMode;
  riskTags: string[];
  suspectedEntrypoints: string[];
  budgetHints: TriageBudgetHints;
  changedFileSummary: TriageChangedFileSummary;
  rationale: string;
}

export interface TriageOptions {
  projectPrompt?: string;
  contextSummary?: string;
}

const DOCUMENTATION_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.rst',
  '.adoc',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
]);

const LOCKFILE_PATTERNS = [
  /\.lock$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
];

const SECURITY_SENSITIVE_PATTERNS = [
  /auth/i,
  /login/i,
  /password/i,
  /secret/i,
  /token/i,
  /crypt/i,
  /permission/i,
  /role/i,
  /acl/i,
  /cors/i,
  /csrf/i,
  /xss/i,
  /credential/i,
  /oauth/i,
  /jwt/i,
  /session/i,
  /\.env/i,
  /dockerfile/i,
  /k8s\//i,
  /helm\//i,
  /terraform\//i,
  /\.github\/workflows\//i,
  /deploy/i,
  /migration/i,
];

const RELIABILITY_PATTERNS = [
  /retry/i,
  /timeout/i,
  /circuit/i,
  /queue/i,
  /worker/i,
  /concurr/i,
  /transaction/i,
  /lock/i,
  /cache/i,
  /db/i,
  /repository/i,
];

const MAINTAINABILITY_PATTERNS = [
  /interface/i,
  /service/i,
  /controller/i,
  /api/i,
  /schema/i,
  /dto/i,
];

function getReviewBudgetPolicy(): ReviewBudgetPolicy {
  return {
    smallMaxFiles: config.review.smallMaxFiles,
    smallMaxChangedLines: config.review.smallMaxChangedLines,
    mediumMaxFiles: config.review.mediumMaxFiles,
    mediumMaxChangedLines: config.review.mediumMaxChangedLines,
    tokenBudgetSmall: config.review.tokenBudgetSmall,
    tokenBudgetMedium: config.review.tokenBudgetMedium,
    tokenBudgetLarge: config.review.tokenBudgetLarge,
  };
}

function hasPattern(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function getFileExtension(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function classifyReviewSize(changedFiles: ChangedFile[], policy: ReviewBudgetPolicy): ReviewSize {
  const fileCount = changedFiles.length;
  const changedLines = changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);

  if (fileCount <= policy.smallMaxFiles && changedLines <= policy.smallMaxChangedLines) {
    return 'small';
  }

  if (fileCount <= policy.mediumMaxFiles && changedLines <= policy.mediumMaxChangedLines) {
    return 'medium';
  }

  return 'large';
}

function getTokenBudget(reviewSize: ReviewSize, policy: ReviewBudgetPolicy): number {
  if (reviewSize === 'small') {
    return policy.tokenBudgetSmall;
  }
  if (reviewSize === 'medium') {
    return policy.tokenBudgetMedium;
  }
  return policy.tokenBudgetLarge;
}

function getBudgetHints(
  mode: ReviewMode,
  reviewSize: ReviewSize,
  policy: ReviewBudgetPolicy
): TriageBudgetHints {
  if (mode === 'skip') {
    return {
      maxTurns: 0,
      maxToolCalls: 0,
      maxElapsedMs: 0,
      tokenBudget: 0,
    };
  }

  const executionBudget =
    mode === 'light'
      ? REVIEW_DEFAULT_BUDGETS.light
      : reviewSize === 'large'
        ? REVIEW_DEFAULT_BUDGETS.largeFull
        : REVIEW_DEFAULT_BUDGETS.full;

  return {
    ...executionBudget,
    tokenBudget: getTokenBudget(reviewSize, policy),
  };
}

function collectRiskTags(changedFiles: ChangedFile[]): string[] {
  const tags = new Set<string>();
  for (const file of changedFiles) {
    const filePath = file.path;
    if (hasPattern(filePath, SECURITY_SENSITIVE_PATTERNS)) {
      tags.add('security-sensitive');
    }
    if (
      hasPattern(filePath, RELIABILITY_PATTERNS) ||
      hasPattern(filePath, MAINTAINABILITY_PATTERNS)
    ) {
      tags.add('quality-sensitive');
    }
    if (/test|spec|__tests__/i.test(filePath)) {
      tags.add('test-change');
    }
    if (
      getFileExtension(filePath) === '.json' ||
      getFileExtension(filePath) === '.yaml' ||
      getFileExtension(filePath) === '.yml'
    ) {
      tags.add('runtime-config-change');
    }
  }
  return [...tags];
}

function isSkipFriendlyChange(changedFiles: ChangedFile[], riskTags: string[]): boolean {
  if (changedFiles.length === 0) {
    return true;
  }

  if (riskTags.includes('security-sensitive') || riskTags.includes('runtime-config-change')) {
    return false;
  }

  const allRenameOnly = changedFiles.every(
    (file) => file.status === 'R' && file.additions + file.deletions === 0
  );
  if (allRenameOnly) {
    return true;
  }

  return changedFiles.every((file) => {
    const ext = getFileExtension(file.path);
    if (LOCKFILE_PATTERNS.some((pattern) => pattern.test(file.path))) {
      return true;
    }
    return DOCUMENTATION_EXTENSIONS.has(ext);
  });
}

function summarizeChangedFiles(changedFiles: ChangedFile[]): TriageChangedFileSummary {
  return {
    totalFiles: changedFiles.length,
    totalAdditions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    files: changedFiles
      .slice(0, 12)
      .map((file) => `${file.status} ${file.path} (+${file.additions} -${file.deletions})`),
  };
}

function collectSuspectedEntrypoints(changedFiles: ChangedFile[]): string[] {
  return changedFiles
    .filter((file) => file.status !== 'D')
    .filter((file) => !DOCUMENTATION_EXTENSIONS.has(getFileExtension(file.path)))
    .slice(0, 12)
    .map((file) => file.path);
}

function buildTriageResult(
  changedFiles: ChangedFile[],
  reviewSize: ReviewSize,
  mode: ReviewMode,
  riskTags: string[],
  rationale: string,
  policy: ReviewBudgetPolicy,
  suspectedEntrypoints = collectSuspectedEntrypoints(changedFiles)
): TriageResult {
  return {
    reviewSize,
    mode,
    riskTags,
    suspectedEntrypoints,
    budgetHints: getBudgetHints(mode, reviewSize, policy),
    changedFileSummary: summarizeChangedFiles(changedFiles),
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Triage Agent
// ---------------------------------------------------------------------------

export class TriageAgent {
  constructor(private readonly gateway: LLMGateway) {}

  /**
   * Analyze the review context and return a triage decision.
   * Uses the 'planner' role for a lightweight, fast LLM call.
   *
   * If the planner role is not configured or the call fails,
   * falls back to a heuristic-based triage.
   */
  async analyze(context: ReviewContext, options?: TriageOptions): Promise<TriageResult> {
    // First try heuristic-based fast path (no LLM call needed for obvious cases)
    const heuristicResult = this.heuristicTriage(context.changedFiles);
    if (heuristicResult) {
      logger.info('Triage: 使用启发式规则快速分流', {
        mode: heuristicResult.mode,
        reviewSize: heuristicResult.reviewSize,
        riskTags: heuristicResult.riskTags,
        suspectedEntrypoints: heuristicResult.suspectedEntrypoints,
        rationale: heuristicResult.rationale,
      });
      return heuristicResult;
    }

    // Fall back to LLM-based triage
    try {
      return await this.llmTriage(context, options);
    } catch (error) {
      logger.warn('Triage: LLM 调用失败，回退到启发式 full 模式提示', {
        error: error instanceof Error ? error.message : String(error),
      });
      const policy = getReviewBudgetPolicy();
      const reviewSize = classifyReviewSize(context.changedFiles, policy);
      return buildTriageResult(
        context.changedFiles,
        reviewSize,
        'full',
        collectRiskTags(context.changedFiles),
        'Triage LLM 调用失败，使用默认 full 模式审查提示',
        policy
      );
    }
  }

  /**
   * Heuristic-based triage — no LLM call needed.
   * Returns null if heuristic is inconclusive (should use LLM).
   */
  private heuristicTriage(changedFiles: ChangedFile[]): TriageResult | null {
    const policy = getReviewBudgetPolicy();

    if (changedFiles.length === 0) {
      return buildTriageResult(changedFiles, 'small', 'skip', [], '无变更文件', policy);
    }

    const riskTags = collectRiskTags(changedFiles);
    const reviewSize = classifyReviewSize(changedFiles, policy);
    const totalChanges = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);

    if (isSkipFriendlyChange(changedFiles, riskTags)) {
      return buildTriageResult(
        changedFiles,
        reviewSize,
        'skip',
        riskTags,
        '文档/资源/锁文件或纯重命名变更，启用 skip 模式',
        policy
      );
    }

    if (changedFiles.length === 1 && totalChanges <= 3) {
      return buildTriageResult(
        changedFiles,
        'small',
        'light',
        riskTags,
        `单文件微量变更（${totalChanges} 行）`,
        policy
      );
    }

    if (reviewSize === 'large') {
      return buildTriageResult(
        changedFiles,
        reviewSize,
        'full',
        riskTags,
        `大规模变更（${changedFiles.length} 文件, ${totalChanges} 行），提供 full 模式预算提示`,
        policy
      );
    }

    const hasSensitiveRisk =
      riskTags.includes('security-sensitive') || riskTags.includes('runtime-config-change');
    const mode: ReviewMode = hasSensitiveRisk || reviewSize === 'medium' ? 'full' : 'light';

    if (hasSensitiveRisk || reviewSize === 'small') {
      return buildTriageResult(
        changedFiles,
        reviewSize,
        mode,
        riskTags,
        hasSensitiveRisk
          ? '命中安全/运行时敏感风险，提升到 full 模式并提供相关入口提示'
          : '小型代码变更，使用 light 模式快速审查提示',
        policy
      );
    }

    // Inconclusive — let LLM decide
    return null;
  }

  /**
   * LLM-based triage using the 'planner' role.
   */
  private async llmTriage(context: ReviewContext, options?: TriageOptions): Promise<TriageResult> {
    const policy = getReviewBudgetPolicy();
    const riskTags = collectRiskTags(context.changedFiles);
    const fileSummary = context.changedFiles
      .map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`)
      .join('\n');

    // Use a small slice of diff for context (just the first 2000 chars for speed)
    const diffPreview = context.diff.slice(0, 2000);

    const compressedSummarySection = options?.contextSummary
      ? `\n压缩上下文摘要（优先参考）：\n${options.contextSummary}\n`
      : '';

    const prompt = `你是代码审查分流专家。分析以下变更并返回给自治审查器使用的上下文提示。${compressedSummarySection}

变更文件列表：
${fileSummary}

Diff 预览（前2000字符）：
${diffPreview}

判断标准：
- **mode=skip**: 纯文档/资源/锁文件/无逻辑改动
- **mode=light**: 小范围可执行代码改动，低风险，最小深度审查
- **mode=full**: 安全/配置/跨模块/中大型改动，需要完整审查

只返回规划提示，不要拆分任务，不要选择审查领域，不要生成子任务。
suspected_entrypoints 只是帮助审查器优先理解上下文的入口提示，不是强制文件范围。

返回 JSON：
{
  "review_size": "small" | "medium" | "large",
  "mode": "skip" | "light" | "full",
  "risk_tags": ["security-sensitive", ...],
  "suspected_entrypoints": ["src/example.ts", ...],
  "rationale": "简要理由"
}`;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: withCoreGlobalPrompt(
          '你是代码变更分流专家，快速判断变更复杂度。返回结构化 JSON，不输出额外文字。',
          mergeReviewPrompts(config.review.globalPrompt, options?.projectPrompt)
        ),
      },
      { role: 'user', content: prompt },
    ];

    const response = await this.gateway.chatForRole('planner', {
      messages,
      temperature: 0,
      responseFormat: 'json',
    });

    const content = response.content;
    if (!content) {
      throw new Error('Triage: planner 模型返回空结果');
    }

    const parsed = JSON.parse(content);

    // Validate and normalize
    const reviewSize = (['small', 'medium', 'large'] as const).includes(parsed.review_size)
      ? (parsed.review_size as ReviewSize)
      : classifyReviewSize(context.changedFiles, policy);

    const mode = (['skip', 'light', 'full'] as const).includes(parsed.mode)
      ? (parsed.mode as ReviewMode)
      : reviewSize === 'small'
        ? 'light'
        : 'full';

    const normalizedRiskTags = Array.isArray(parsed.risk_tags)
      ? parsed.risk_tags.filter((tag: unknown) => typeof tag === 'string')
      : riskTags;

    const parsedEntrypoints = Array.isArray(parsed.suspected_entrypoints)
      ? parsed.suspected_entrypoints.filter((entrypoint: unknown) => typeof entrypoint === 'string')
      : collectSuspectedEntrypoints(context.changedFiles);

    const result = buildTriageResult(
      context.changedFiles,
      reviewSize,
      mode,
      normalizedRiskTags,
      parsed.rationale || '',
      policy,
      parsedEntrypoints.slice(0, 12)
    );

    logger.info('Triage: LLM 分流完成', {
      reviewSize: result.reviewSize,
      mode: result.mode,
      riskTags: result.riskTags,
      suspectedEntrypoints: result.suspectedEntrypoints,
      rationale: result.rationale,
    });

    return result;
  }
}
