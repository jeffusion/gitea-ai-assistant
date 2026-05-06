import type { TriageResult } from '../agents/triage-agent';
import type { Finding, FindingCategory, ReviewContext, ReviewDecision, ReviewTask } from '../types';
import type { CompressedReviewContext } from './context-compression-service';

export type PendingFinding = Omit<Finding, 'id' | 'runId' | 'published'>;

export interface ReviewPolicyResult {
  publishable: PendingFinding[];
  gated: PendingFinding[];
  dropped: PendingFinding[];
}

export interface ReviewKernelState {
  targetSha?: string;
  mirrorPath?: string;
  workspacePath?: string;
  lastReviewedHead?: string;
  context?: ReviewContext;
  compressedContext?: CompressedReviewContext;
  projectPrompt?: string;
  triage?: TriageResult | null;
  domainTasks: ReviewTask[];
  completedDomains: FindingCategory[];
  findings: PendingFinding[];
  decision?: ReviewDecision;
  policyResult?: ReviewPolicyResult;
  published: boolean;
  reviewedRefSaved: boolean;
}
