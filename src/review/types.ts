export type ReviewEngineMode = 'codex' | 'kernel';

export type ReviewEventType = 'pull_request' | 'commit_status';

export type ReviewRunStatus = 'queued' | 'in_progress' | 'succeeded' | 'failed' | 'ignored';

export type FindingSeverity = 'high' | 'medium' | 'low';

export type FindingCategory = 'correctness' | 'security' | 'quality';

export type ReviewMode = 'skip' | 'light' | 'full';

export type ReviewSize = 'small' | 'medium' | 'large';

export interface ReviewTask {
  domain: FindingCategory;
  paths: string[];
  riskTags: string[];
  mode: ReviewMode;
  tokenBudget: number;
  maxIterations: number;
  allowTools: boolean;
}

export interface ReviewBudgetPolicy {
  smallMaxFiles: number;
  smallMaxChangedLines: number;
  mediumMaxFiles: number;
  mediumMaxChangedLines: number;
  tokenBudgetSmall: number;
  tokenBudgetMedium: number;
  tokenBudgetLarge: number;
}

export interface ReviewRun {
  id: string;
  idempotencyKey: string;
  eventType: ReviewEventType;
  status: ReviewRunStatus;
  owner: string;
  repo: string;
  cloneUrl: string;
  headCloneUrl?: string; // Fork PR场景：head commit的源仓库URL，用于fetch head SHA
  prNumber?: number;
  relatedPrNumber?: number;
  baseSha?: string;
  headSha?: string;
  commitSha?: string;
  commitMessage?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ReviewStep {
  id: string;
  runId: string;
  stepName: string;
  agentName?: string;
  status: 'started' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  latencyMs?: number;
  inputRef?: string;
  outputRef?: string;
  error?: string;
}

export interface Finding {
  id: string;
  runId: string;
  fingerprint: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  path: string;
  line: number;
  title: string;
  detail: string;
  evidence: string;
  suggestion: string;
  published: boolean;
}

export interface ReviewCommentRecord {
  id: string;
  runId: string;
  path?: string;
  line?: number;
  body: string;
  giteaCommentId?: number;
  status: 'pending' | 'published' | 'failed';
  createdAt: string;
  fingerprint?: string; // Finding fingerprint for matching feedback to specific findings
}

export interface ReviewPayloadBase {
  idempotencyKey: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  headCloneUrl?: string; // Fork PR场景：head commit的源仓库URL
  maxAttempts?: number;
}

export interface PullRequestReviewPayload extends ReviewPayloadBase {
  eventType: 'pull_request';
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export interface CommitReviewPayload extends ReviewPayloadBase {
  eventType: 'commit_status';
  commitSha: string;
  commitMessage?: string;
  relatedPrNumber?: number;
}

export type ReviewPayload = PullRequestReviewPayload | CommitReviewPayload;

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';
  additions: number;
  deletions: number;
}

export interface DiffLine {
  lineNumber: number;
  oldLineNumber?: number;
  content: string;
  type: 'add' | 'context' | 'delete';
}

export interface DiffFile {
  path: string;
  changes: DiffLine[];
}

export interface ReviewContext {
  workspacePath: string;
  mirrorPath: string;
  diff: string;
  changedFiles: ChangedFile[];
  parsedDiff: DiffFile[];
  fileContents: Record<string, string>;
}

export interface AgentResult {
  agentName: string;
  findings: Omit<Finding, 'id' | 'runId' | 'published'>[];
  diagnostics?: {
    scopedPaths?: string[];
    compactContextTokens?: number;
    iterations?: number;
    toolCallNames?: string[];
    parsedFindingCount?: number;
    finalResponsePreview?: string;
    parseErrors?: string[];
    emptyResponseCount?: number;
  };
}

export interface ReviewDecision {
  summaryMarkdown: string;
  findings: Omit<Finding, 'id' | 'runId' | 'published'>[];
}
