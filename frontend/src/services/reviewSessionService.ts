import api from '@/lib/api';

export type ReviewRunStatus = 'queued' | 'in_progress' | 'succeeded' | 'failed' | 'ignored';

export interface ReviewRun {
  id: string;
  idempotencyKey: string;
  eventType: 'pull_request' | 'commit_status';
  status: ReviewRunStatus;
  owner: string;
  repo: string;
  cloneUrl: string;
  headCloneUrl?: string;
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
  category: 'correctness' | 'security' | 'reliability' | 'maintainability';
  severity: 'high' | 'medium' | 'low';
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
  fingerprint?: string;
}

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  sequence: number;
  role: string;
  content: any;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface AgentToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string;
  sequence: number;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  arguments: any;
  result?: any;
  error?: any;
  createdAt: string;
  completedAt?: string;
}

export interface AgentInvocationRecord {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  sequence: number;
  agentType: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: any;
  result?: any;
  error?: any;
  createdAt: string;
  completedAt?: string;
}

export interface AgentSessionTree {
  id: string;
  parentSessionId?: string;
  parentInvocationId?: string;
  agentType: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  metadata: Record<string, any>;
  finalResult?: any;
  error?: any;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessageRecord[];
  toolCalls: AgentToolCallRecord[];
  invocations: Array<AgentInvocationRecord & { childSession?: AgentSessionTree }>;
}

export interface ReviewRunDetails {
  run: ReviewRun;
  steps: ReviewStep[];
  findings: Finding[];
  comments: ReviewCommentRecord[];
  sessionTree?: AgentSessionTree | null;
}

export const fetchReviewRuns = async (limit: number = 50): Promise<{ data: ReviewRun[] }> => {
  const response = await api.get<{ data: ReviewRun[] }>('/review/runs', {
    params: { limit },
  });
  return response.data;
};

export const fetchReviewRunDetails = async (runId: string): Promise<ReviewRunDetails> => {
  const response = await api.get<ReviewRunDetails>(`/review/runs/${runId}`);
  return response.data;
};
