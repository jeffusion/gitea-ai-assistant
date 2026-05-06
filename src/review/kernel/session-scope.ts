import type { ReviewRun } from '../types';

export function getReviewSessionScope(
  run: Pick<ReviewRun, 'owner' | 'repo' | 'prNumber' | 'relatedPrNumber' | 'commitSha'>
): {
  scopeType: 'pull_request' | 'commit';
  scopeKey: string;
} {
  if (run.prNumber) {
    return {
      scopeType: 'pull_request',
      scopeKey: `${run.owner}/${run.repo}#${run.prNumber}`,
    };
  }

  if (run.relatedPrNumber) {
    return {
      scopeType: 'pull_request',
      scopeKey: `${run.owner}/${run.repo}#${run.relatedPrNumber}`,
    };
  }

  return {
    scopeType: 'commit',
    scopeKey: `${run.owner}/${run.repo}@${run.commitSha}`,
  };
}
