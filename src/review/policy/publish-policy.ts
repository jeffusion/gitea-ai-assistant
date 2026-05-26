import { Finding } from '../types';

export interface PublishPolicyResult {
  publishable: Omit<Finding, 'id' | 'runId' | 'published'>[];
  dropped: Omit<Finding, 'id' | 'runId' | 'published'>[];
}

export function applyPublishPolicy(
  findings: Omit<Finding, 'id' | 'runId' | 'published'>[]
): PublishPolicyResult {
  const publishable: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];
  const dropped: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];

  for (const finding of findings) {
    if (finding.severity === 'high' || finding.severity === 'medium') {
      publishable.push(finding);
      continue;
    }

    dropped.push(finding);
  }

  return { publishable, dropped };
}
