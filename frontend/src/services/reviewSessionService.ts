import api from '@/lib/api';

export interface ReviewSessionSummaryRecordDto {
  session: {
    id: string;
    scopeType: 'pull_request' | 'commit';
    scopeKey: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    lastRunId?: string;
  };
  summary: {
    sessionId: string;
    scopeKey: string;
    scopeType: 'pull_request' | 'commit';
    owner?: string;
    repo?: string;
    prNumber?: number;
    headSha?: string;
    status:
      | 'queued'
      | 'planning'
      | 'executing'
      | 'awaiting_human_feedback'
      | 'completed'
      | 'failed'
      | 'ignored';
    currentStep?: string;
    findingCount: number;
    pendingTaskCount: number;
    updatedAt: string;
  };
}

export interface ReviewPlanStepDto {
  key: string;
  label: string;
  description: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  progressText?: string;
}

export interface ReviewTimelineEntryDto {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export interface ReviewSessionDetailDto {
  session: ReviewSessionSummaryRecordDto['session'];
  summary: ReviewSessionSummaryRecordDto['summary'];
  checkpoint: {
    state: Record<string, unknown>;
    pendingTasks: Array<{ kind: 'skill' | 'subagent'; name: string; input?: Record<string, unknown> }>;
    stopReason?: string;
  } | null;
  plan: ReviewPlanStepDto[];
  timeline: ReviewTimelineEntryDto[];
  events: Array<{
    id: string;
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  runDetails: {
    run: {
      id: string;
      eventType: string;
      status: string;
      owner: string;
      repo: string;
      prNumber?: number;
      commitSha?: string;
      headSha?: string;
      baseSha?: string;
      createdAt: string;
      updatedAt: string;
    };
    findings: Array<{
      id: string;
      title: string;
      detail: string;
      evidence: string;
      suggestion: string;
      severity: 'high' | 'medium' | 'low';
      category: string;
      path: string;
      line: number;
      confidence: number;
      published: boolean;
      fingerprint: string;
    }>;
    comments: Array<{
      id: string;
      status: string;
      body: string;
      path?: string;
      line?: number;
      createdAt: string;
    }>;
  } | null;
}

export interface ReviewSessionListResponse {
  data: ReviewSessionSummaryRecordDto[];
}

export const fetchReviewSessions = async (): Promise<ReviewSessionSummaryRecordDto[]> => {
  const response = await api.get<ReviewSessionListResponse>('/review/sessions');
  return response.data.data;
};

export const fetchReviewSessionDetail = async (
  sessionId: string
): Promise<ReviewSessionDetailDto> => {
  const response = await api.get<ReviewSessionDetailDto>(`/review/sessions/${sessionId}`);
  return response.data;
};
