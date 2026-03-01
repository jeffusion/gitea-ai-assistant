import { ReviewDecision, Finding } from '../types';

const severityWeight: Record<Finding['severity'], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function summarizeFindings(findings: Omit<Finding, 'id' | 'runId' | 'published'>[]): string {
  if (findings.length === 0) {
    return '本次变更未发现需要立即处理的高置信问题。建议人工快速复核关键业务路径。';
  }

  const total = findings.length;
  const high = findings.filter((item) => item.severity === 'high').length;
  const medium = findings.filter((item) => item.severity === 'medium').length;
  const low = findings.filter((item) => item.severity === 'low').length;

  return [
    `本次 AI Agent 审查共识别 ${total} 个问题，其中 high ${high} 个、medium ${medium} 个、low ${low} 个。`,
    '以下评论按风险优先级自动发布，建议优先处理 high 与 medium 项。',
  ].join('\n\n');
}

export class JudgeAgent {
  judge(results: Omit<Finding, 'id' | 'runId' | 'published'>[]): ReviewDecision {
    const bestByFingerprint = new Map<string, Omit<Finding, 'id' | 'runId' | 'published'>>();

    for (const finding of results) {
      const existing = bestByFingerprint.get(finding.fingerprint);
      if (!existing) {
        bestByFingerprint.set(finding.fingerprint, finding);
        continue;
      }

      const existingWeight = severityWeight[existing.severity] * existing.confidence;
      const currentWeight = severityWeight[finding.severity] * finding.confidence;
      if (currentWeight > existingWeight) {
        bestByFingerprint.set(finding.fingerprint, finding);
      }
    }

    const findings = [...bestByFingerprint.values()].sort((a, b) => {
      const scoreA = severityWeight[a.severity] * a.confidence;
      const scoreB = severityWeight[b.severity] * b.confidence;
      return scoreB - scoreA;
    });

    return {
      summaryMarkdown: summarizeFindings(findings),
      findings,
    };
  }
}
