import { Finding } from '../types';

export interface PublishPolicyResult {
  publishable: Omit<Finding, 'id' | 'runId' | 'published'>[];
  gated: Omit<Finding, 'id' | 'runId' | 'published'>[];
  dropped: Omit<Finding, 'id' | 'runId' | 'published'>[];
}

export function applyPublishPolicy(
  findings: Omit<Finding, 'id' | 'runId' | 'published'>[],
  minConfidence: number,
  enableHumanGate: boolean
): PublishPolicyResult {
  const publishable: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];
  const gated: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];
  const dropped: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];

  for (const finding of findings) {
    const meetsConfidence = finding.confidence >= minConfidence;
    const lowSeverity = finding.severity === 'low';

    // 高置信度 + 中/高严重度 → 直接发布
    if (meetsConfidence && !lowSeverity) {
      publishable.push(finding);
      continue;
    }

    // 人工门禁开启时，所有未达标的 finding 进入待审批队列
    if (enableHumanGate) {
      gated.push(finding);
      continue;
    }

    // 人工门禁关闭时，明确记录被丢弃的 findings（低置信度或低严重度）
    // 低严重度但高置信度的 finding 也不自动发布，避免开发者产生噪音疲劳
    dropped.push(finding);
  }

  return { publishable, gated, dropped };
}
