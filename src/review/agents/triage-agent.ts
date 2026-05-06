/**
 * Triage Agent — lightweight intent recognition using the 'planner' model role.
 *
 * Analyzes the change summary (file list + basic stats) to determine:
 *   1. Change complexity (trivial / standard / complex)
 *   2. Which specialist domains are relevant
 *
 * This avoids wasting tokens by running all specialist agents on trivial changes
 * (e.g. README typo fixes, string-only edits, pure documentation changes).
 */

import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage } from '../../llm/types';
import { mergeReviewPrompts, withCoreGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import type {
  ChangedFile,
  FindingCategory,
  ReviewBudgetPolicy,
  ReviewContext,
  ReviewMode,
  ReviewSize,
  ReviewTask,
} from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageComplexity = 'trivial' | 'standard' | 'complex';

export interface TriageResult {
  /** How complex the change is — drives how many agents to dispatch. */
  complexity: TriageComplexity;
  reviewSize: ReviewSize;
  mode: ReviewMode;
  tasks: ReviewTask[];
  riskTags: string[];
  /** Brief rationale from the planner model. */
  rationale: string;
}

export interface TriageOptions {
  projectPrompt?: string;
  contextSummary?: string;
}

/** All valid finding categories. */
const ALL_DOMAINS: FindingCategory[] = ['correctness', 'security', 'quality'];

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

function toComplexity(mode: ReviewMode, reviewSize: ReviewSize): TriageComplexity {
  if (mode === 'skip') {
    return 'trivial';
  }
  if (reviewSize === 'small') {
    return mode === 'full' ? 'standard' : 'trivial';
  }
  if (reviewSize === 'large') {
    return 'complex';
  }
  return 'standard';
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

function buildDomainPaths(changedFiles: ChangedFile[], domain: FindingCategory): string[] {
  const candidatePaths = changedFiles
    .filter((file) => file.status !== 'D')
    .map((file) => file.path);
  if (candidatePaths.length === 0) {
    return [];
  }

  if (domain === 'security') {
    const scoped = candidatePaths.filter((filePath) =>
      hasPattern(filePath, SECURITY_SENSITIVE_PATTERNS)
    );
    return scoped.length > 0 ? scoped : candidatePaths;
  }

  if (domain === 'quality') {
    const scoped = candidatePaths.filter(
      (filePath) =>
        hasPattern(filePath, RELIABILITY_PATTERNS) || hasPattern(filePath, MAINTAINABILITY_PATTERNS)
    );
    return scoped.length > 0 ? scoped : candidatePaths;
  }

  return candidatePaths;
}

function buildTasks(
  domains: FindingCategory[],
  changedFiles: ChangedFile[],
  reviewSize: ReviewSize,
  mode: ReviewMode,
  riskTags: string[],
  policy: ReviewBudgetPolicy
): ReviewTask[] {
  if (mode === 'skip') {
    return [];
  }

  const tokenBudget = getTokenBudget(reviewSize, policy);
  const maxIterations = mode === 'light' ? 1 : 2;

  return domains.map((domain) => {
    const scopedPaths = buildDomainPaths(changedFiles, domain);
    return {
      domain,
      paths: scopedPaths,
      riskTags,
      mode,
      tokenBudget,
      maxIterations,
      allowTools: mode === 'full',
      allowReflection: mode === 'full' && (domain === 'correctness' || domain === 'security'),
    };
  });
}

function decideDomains(
  changedFiles: ChangedFile[],
  riskTags: string[],
  reviewSize: ReviewSize
): FindingCategory[] {
  const domains: FindingCategory[] = ['correctness'];

  const hasSecurityFiles = riskTags.includes('security-sensitive');
  const hasQualityFiles = riskTags.includes('quality-sensitive');

  if (hasSecurityFiles) {
    domains.push('security');
  }
  if (hasQualityFiles || changedFiles.length >= 4 || reviewSize === 'large') {
    domains.push('quality');
  }

  if (reviewSize === 'large') {
    return [...ALL_DOMAINS];
  }

  return [...new Set(domains)];
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
        complexity: heuristicResult.complexity,
        tasks: heuristicResult.tasks.length,
        mode: heuristicResult.mode,
        rationale: heuristicResult.rationale,
      });
      return heuristicResult;
    }

    // Fall back to LLM-based triage
    try {
      return await this.llmTriage(context, options);
    } catch (error) {
      logger.warn('Triage: LLM 调用失败，回退到启发式全量派发', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        complexity: 'complex',
        reviewSize: 'large',
        mode: 'full',
        tasks: buildTasks(
          [...ALL_DOMAINS],
          context.changedFiles,
          'large',
          'full',
          collectRiskTags(context.changedFiles),
          getReviewBudgetPolicy()
        ),
        riskTags: collectRiskTags(context.changedFiles),
        rationale: 'Triage LLM 调用失败，使用默认全量审查',
      };
    }
  }

  /**
   * Heuristic-based triage — no LLM call needed.
   * Returns null if heuristic is inconclusive (should use LLM).
   */
  private heuristicTriage(changedFiles: ChangedFile[]): TriageResult | null {
    const policy = getReviewBudgetPolicy();

    if (changedFiles.length === 0) {
      return {
        complexity: 'trivial',
        reviewSize: 'small',
        mode: 'skip',
        tasks: [],
        riskTags: [],
        rationale: '无变更文件',
      };
    }

    const riskTags = collectRiskTags(changedFiles);
    const reviewSize = classifyReviewSize(changedFiles, policy);
    const totalChanges = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);

    if (isSkipFriendlyChange(changedFiles, riskTags)) {
      return {
        complexity: 'trivial',
        reviewSize,
        mode: 'skip',
        tasks: [],
        riskTags,
        rationale: '文档/资源/锁文件或纯重命名变更，启用 skip 模式',
      };
    }

    if (changedFiles.length === 1 && totalChanges <= 3) {
      const domains = ['correctness'] as FindingCategory[];
      return {
        complexity: 'trivial',
        reviewSize: 'small',
        mode: 'light',
        tasks: buildTasks(domains, changedFiles, 'small', 'light', riskTags, policy),
        riskTags,
        rationale: `单文件微量变更（${totalChanges} 行）`,
      };
    }

    if (reviewSize === 'large') {
      const domains = [...ALL_DOMAINS];
      return {
        complexity: 'complex',
        reviewSize,
        mode: 'full',
        tasks: buildTasks(domains, changedFiles, reviewSize, 'full', riskTags, policy),
        riskTags,
        rationale: `大规模变更（${changedFiles.length} 文件, ${totalChanges} 行），全量任务审查`,
      };
    }

    const domains = decideDomains(changedFiles, riskTags, reviewSize);
    const hasSensitiveRisk =
      riskTags.includes('security-sensitive') || riskTags.includes('runtime-config-change');
    const mode: ReviewMode = hasSensitiveRisk || reviewSize === 'medium' ? 'full' : 'light';

    if (hasSensitiveRisk || reviewSize === 'small') {
      return {
        complexity: toComplexity(mode, reviewSize),
        reviewSize,
        mode,
        tasks: buildTasks(domains, changedFiles, reviewSize, mode, riskTags, policy),
        riskTags,
        rationale: hasSensitiveRisk
          ? '命中安全/运行时敏感风险，提升到 full 模式并限制到相关路径'
          : '小型代码变更，使用 light 模式快速审查',
      };
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

    const prompt = `你是代码审查分流专家。分析以下变更并判断其复杂度、审查模式和审查领域。${compressedSummarySection}

变更文件列表：
${fileSummary}

Diff 预览（前2000字符）：
${diffPreview}

判断标准：
- **mode=skip**: 纯文档/资源/锁文件/无逻辑改动
- **mode=light**: 小范围可执行代码改动，低风险，最小深度审查
- **mode=full**: 安全/配置/跨模块/中大型改动，需要完整审查

可选领域：correctness（逻辑正确性）, security（安全）, quality（可靠性、可维护性与可测试性）

返回 JSON：
{
  "complexity": "trivial" | "standard" | "complex",
  "review_size": "small" | "medium" | "large",
  "mode": "skip" | "light" | "full",
  "relevant_domains": ["correctness", ...],
  "risk_tags": ["security-sensitive", ...],
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
    const complexity = (['trivial', 'standard', 'complex'] as const).includes(parsed.complexity)
      ? (parsed.complexity as TriageComplexity)
      : 'standard';

    const reviewSize = (['small', 'medium', 'large'] as const).includes(parsed.review_size)
      ? (parsed.review_size as ReviewSize)
      : classifyReviewSize(context.changedFiles, policy);

    const mode = (['skip', 'light', 'full'] as const).includes(parsed.mode)
      ? (parsed.mode as ReviewMode)
      : reviewSize === 'small'
        ? 'light'
        : 'full';

    const relevantDomains: FindingCategory[] =
      mode === 'skip'
        ? []
        : Array.isArray(parsed.relevant_domains)
          ? (parsed.relevant_domains.filter((d: string) =>
              ALL_DOMAINS.includes(d as FindingCategory)
            ) as FindingCategory[])
          : [...ALL_DOMAINS];

    // Ensure at least correctness is always included
    if (mode !== 'skip' && !relevantDomains.includes('correctness')) {
      relevantDomains.unshift('correctness');
    }

    const normalizedRiskTags = Array.isArray(parsed.risk_tags)
      ? parsed.risk_tags.filter((tag: unknown) => typeof tag === 'string')
      : riskTags;

    const result: TriageResult = {
      complexity,
      reviewSize,
      mode,
      tasks: buildTasks(
        relevantDomains,
        context.changedFiles,
        reviewSize,
        mode,
        normalizedRiskTags,
        policy
      ),
      riskTags: normalizedRiskTags,
      rationale: parsed.rationale || '',
    };

    logger.info('Triage: LLM 分流完成', {
      complexity: result.complexity,
      reviewSize: result.reviewSize,
      mode: result.mode,
      tasks: result.tasks.length,
      rationale: result.rationale,
    });

    return result;
  }
}
