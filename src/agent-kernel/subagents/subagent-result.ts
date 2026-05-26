export type SubagentResultStatus = 'completed' | 'failed';

export interface SubagentResult {
  status: SubagentResultStatus;
  summary: string;
  messagesCount: number;
  toolCallCount: number;
  totalTokens?: number;
  artifacts?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}
