/**
 * Triage Agent — lightweight intent recognition using the 'planner' model role.
 *
 * Analyzes the change summary (file list + basic stats) to determine:
 *   1. Change complexity (trivial / standard / complex)
 *   2. Which specialist domains are relevant
 *
 * This avoids wasting tokens by running all 4 specialist agents on trivial changes
 * (e.g. README typo fixes, string-only edits, pure documentation changes).
 */

import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage } from '../../llm/types';
import { withGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import type { ChangedFile, FindingCategory, ReviewContext } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageComplexity = 'trivial' | 'standard' | 'complex';

export interface TriageResult {
  /** How complex the change is — drives how many agents to dispatch. */
  complexity: TriageComplexity;
  /** Which specialist domains are relevant for this change. */
  relevantDomains: FindingCategory[];
  /** Brief rationale from the planner model. */
  rationale: string;
}

/** All valid finding categories. */
const ALL_DOMAINS: FindingCategory[] = [
  'correctness',
  'security',
  'reliability',
  'maintainability',
];

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
  async analyze(context: ReviewContext): Promise<TriageResult> {
    // First try heuristic-based fast path (no LLM call needed for obvious cases)
    const heuristicResult = this.heuristicTriage(context.changedFiles);
    if (heuristicResult) {
      logger.info('Triage: 使用启发式规则快速分流', {
        complexity: heuristicResult.complexity,
        domains: heuristicResult.relevantDomains.join(','),
        rationale: heuristicResult.rationale,
      });
      return heuristicResult;
    }

    // Fall back to LLM-based triage
    try {
      return await this.llmTriage(context);
    } catch (error) {
      logger.warn('Triage: LLM 调用失败，回退到启发式全量派发', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        complexity: 'standard',
        relevantDomains: [...ALL_DOMAINS],
        rationale: 'Triage LLM 调用失败，使用默认全量审查',
      };
    }
  }

  /**
   * Heuristic-based triage — no LLM call needed.
   * Returns null if heuristic is inconclusive (should use LLM).
   */
  private heuristicTriage(changedFiles: ChangedFile[]): TriageResult | null {
    if (changedFiles.length === 0) {
      return {
        complexity: 'trivial',
        relevantDomains: ['correctness'],
        rationale: '无变更文件',
      };
    }

    const NON_CODE_EXTENSIONS = new Set([
      '.md',
      '.txt',
      '.rst',
      '.adoc', // docs
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ini', // config (non-security)
      '.css',
      '.scss',
      '.less',
      '.svg', // styles/assets
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.ico',
      '.webp', // images
      '.lock', // lockfiles
    ]);

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
      /\.env/,
      /credential/i,
      /oauth/i,
      /jwt/i,
      /session/i,
    ];

    const allNonCode = changedFiles.every((f) => {
      const ext = f.path.substring(f.path.lastIndexOf('.')).toLowerCase();
      return NON_CODE_EXTENSIONS.has(ext);
    });

    if (allNonCode) {
      return {
        complexity: 'trivial',
        relevantDomains: ['correctness'],
        rationale: '所有变更文件均为非代码文件（文档/配置/资源）',
      };
    }

    // Very small change (≤3 lines total) in a single file → trivial
    const totalChanges = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    if (changedFiles.length === 1 && totalChanges <= 3) {
      return {
        complexity: 'trivial',
        relevantDomains: ['correctness'],
        rationale: `单文件微量变更（${totalChanges} 行）`,
      };
    }

    // Check for security-sensitive files
    const hasSecurityFiles = changedFiles.some((f) =>
      SECURITY_SENSITIVE_PATTERNS.some((p) => p.test(f.path))
    );

    // Large PR (many files or large changes) → complex
    if (changedFiles.length > 20 || totalChanges > 500) {
      return {
        complexity: 'complex',
        relevantDomains: [...ALL_DOMAINS],
        rationale: `大规模变更（${changedFiles.length} 文件, ${totalChanges} 行）`,
      };
    }

    // Security-sensitive file detected → ensure security agent is included
    if (hasSecurityFiles && changedFiles.length <= 5 && totalChanges <= 100) {
      return {
        complexity: 'standard',
        relevantDomains: ['correctness', 'security'],
        rationale: '涉及安全相关文件，仅派发 correctness + security',
      };
    }

    // Inconclusive — let LLM decide
    return null;
  }

  /**
   * LLM-based triage using the 'planner' role.
   */
  private async llmTriage(context: ReviewContext): Promise<TriageResult> {
    const fileSummary = context.changedFiles
      .map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`)
      .join('\n');

    // Use a small slice of diff for context (just the first 2000 chars for speed)
    const diffPreview = context.diff.slice(0, 2000);

    const prompt = `你是代码审查分流专家。分析以下变更并判断其复杂度和需要哪些审查领域。

变更文件列表：
${fileSummary}

Diff 预览（前2000字符）：
${diffPreview}

判断标准：
- **trivial**: 纯文档、注释、字符串修改、格式化、重命名等无逻辑变更 → 只需 correctness
- **standard**: 单模块逻辑修改、普通功能开发 → 按实际涉及领域选择
- **complex**: 多模块/跨层修改、架构变更、并发/安全关键路径 → 全部领域

可选领域：correctness（逻辑正确性）, security（安全）, reliability（可靠性）, maintainability（可维护性）

返回 JSON：
{
  "complexity": "trivial" | "standard" | "complex",
  "relevant_domains": ["correctness", ...],
  "rationale": "简要理由"
}`;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: withGlobalPrompt(
          '你是代码变更分流专家，快速判断变更复杂度。返回结构化 JSON，不输出额外文字。',
          config.review.globalPrompt
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

    const relevantDomains: FindingCategory[] = Array.isArray(parsed.relevant_domains)
      ? (parsed.relevant_domains.filter((d: string) =>
          ALL_DOMAINS.includes(d as FindingCategory)
        ) as FindingCategory[])
      : [...ALL_DOMAINS];

    // Ensure at least correctness is always included
    if (!relevantDomains.includes('correctness')) {
      relevantDomains.unshift('correctness');
    }

    const result: TriageResult = {
      complexity,
      relevantDomains,
      rationale: parsed.rationale || '',
    };

    logger.info('Triage: LLM 分流完成', {
      complexity: result.complexity,
      domains: result.relevantDomains.join(','),
      rationale: result.rationale,
    });

    return result;
  }
}
