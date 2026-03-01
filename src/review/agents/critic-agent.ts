import OpenAI from 'openai';
import { Finding, ReviewContext } from '../types';
import { logger } from '../../utils/logger';

export interface CritiqueResult {
  qualityScore: number; // 0-1
  issues: CritiqueIssue[];
  missedIssues: string[];
  overallAssessment: string;
}

export interface CritiqueIssue {
  findingIndex: number;
  problem: string;
  suggestion: string;
  severity: 'high' | 'medium' | 'low';
}

export class CriticAgent {
  constructor(
    private openai: OpenAI,
    private model: string
  ) {}

  async critique(
    findings: Omit<Finding, 'id' | 'runId' | 'published'>[],
    context: ReviewContext
  ): Promise<CritiqueResult> {
    if (findings.length === 0) {
      return {
        qualityScore: 1.0,
        issues: [],
        missedIssues: [],
        overallAssessment: '无findings需要评估',
      };
    }

    const prompt = `你是严格的代码审查质量评估专家。评估以下审查结果的质量。

审查结果（${findings.length}个问题）：
${JSON.stringify(findings, null, 2)}

原始代码变更片段（供参考）：
${context.diff.slice(0, 3000)}

评估标准：
1. **Evidence充分性**: 证据是否充分支持结论？是否引用了具体代码？
2. **误报风险**: 是否可能是false positive？是否考虑了上下文？
3. **Severity准确性**: 严重性评估是否合理？
4. **Confidence合理性**: 置信度评分是否反映了证据强度？
5. **Suggestion可行性**: 建议是否具体、可操作？
6. **遗漏问题**: 是否遗漏了明显的问题？

返回JSON格式：
{
  "quality_score": 0.0-1.0,
  "issues": [
    {
      "finding_index": 0,
      "problem": "证据不足，仅基于猜测",
      "suggestion": "需要引用具体代码行并说明为何存在问题",
      "severity": "high" | "medium" | "low"
    }
  ],
  "missed_issues": [
    "可能遗漏的问题描述"
  ],
  "overall_assessment": "总体评估说明"
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0.1, // 略高于0以允许批判性思考
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是严格的代码审查质量评估专家，以高标准评估findings的质量。',
          },
          { role: 'user', content: prompt },
        ],
      });

      const content = response.choices[0]?.message.content;
      if (!content) {
        throw new Error('Critic Agent返回空结果');
      }

      const parsed = JSON.parse(content);

      const result: CritiqueResult = {
        // 使用 ?? 而非 ||，保留有效的0分（最差评价）
        qualityScore: parsed.quality_score ?? 0.5,
        issues: (parsed.issues || []).map((issue: any) => ({
          findingIndex: issue.finding_index || 0,
          problem: issue.problem || '',
          suggestion: issue.suggestion || '',
          severity: issue.severity || 'medium',
        })),
        missedIssues: parsed.missed_issues || [],
        overallAssessment: parsed.overall_assessment || '',
      };

      logger.debug('Critic Agent评估完成', {
        findingsCount: findings.length,
        qualityScore: result.qualityScore,
        issuesFound: result.issues.length,
        missedIssues: result.missedIssues.length,
      });

      return result;
    } catch (error) {
      logger.error('Critic Agent执行失败', {
        error: error instanceof Error ? error.message : String(error),
      });

      // 返回默认评估，避免阻塞流程
      return {
        qualityScore: 0.7,
        issues: [],
        missedIssues: [],
        overallAssessment: 'Critic Agent执行失败，使用默认评估',
      };
    }
  }

  async evaluateSingleFinding(
    finding: Omit<Finding, 'id' | 'runId' | 'published'>,
    context: ReviewContext
  ): Promise<{
    isValid: boolean;
    confidence: number;
    issues: string[];
  }> {
    const prompt = `评估以下代码审查finding的有效性：

Finding:
- Title: ${finding.title}
- Detail: ${finding.detail}
- Evidence: ${finding.evidence}
- Severity: ${finding.severity}
- Confidence: ${finding.confidence}

代码上下文：
${context.diff.slice(0, 2000)}

判断：
1. 这个finding是否有效（不是误报）？
2. 置信度评估是否合理？
3. 有哪些问题或改进建议？

返回JSON：
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "issues": ["问题描述1", "问题描述2"]
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是代码审查质量评估专家。',
          },
          { role: 'user', content: prompt },
        ],
      });

      const content = response.choices[0]?.message.content;
      if (!content) {
        throw new Error('评估失败');
      }

      const parsed = JSON.parse(content);

      return {
        isValid: parsed.is_valid ?? true,
        confidence: parsed.confidence ?? finding.confidence,
        issues: parsed.issues || [],
      };
    } catch (error) {
      logger.error('单个finding评估失败', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        isValid: true,
        confidence: finding.confidence,
        issues: [],
      };
    }
  }
}
