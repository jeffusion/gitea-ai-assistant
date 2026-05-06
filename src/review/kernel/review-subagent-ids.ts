import type { FindingCategory } from '../types';

export const REVIEW_TRIAGE_SUBAGENT = 'review:triage';

export function getReviewDomainSubagentId(domain: FindingCategory): string {
  return `review:specialist:${domain}`;
}
