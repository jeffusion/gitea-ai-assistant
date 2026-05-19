import type { TriageResult } from '../agents/triage-agent';
import type {
  AgentResult,
  Finding,
  ReviewContext,
  ReviewDecision,
  ReviewHint,
  ReviewTask,
} from '../types';
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
  reviewTask?: ReviewTask;
  reviewCompleted: boolean;
  reviewHints: ReviewHint[];
  reviewDiagnostics?: AgentResult['diagnostics'];
  findings: PendingFinding[];
  decision?: ReviewDecision;
  policyResult?: ReviewPolicyResult;
  published: boolean;
  reviewedRefSaved: boolean;
}
