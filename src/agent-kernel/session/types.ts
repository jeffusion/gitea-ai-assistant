export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentToolCallStatus = 'running' | 'completed' | 'failed';

export interface CreateAgentSessionInput {
  id?: string;
  parentSessionId?: string;
  parentInvocationId?: string;
  agentType: string;
  model: string;
  status?: AgentSessionStatus;
  metadata?: Record<string, unknown>;
}

export interface AgentSessionRecord {
  id: string;
  parentSessionId?: string;
  parentInvocationId?: string;
  agentType: string;
  model: string;
  status: AgentSessionStatus;
  metadata: Record<string, unknown>;
  finalResult?: unknown;
  error?: unknown;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppendAgentMessageInput {
  id?: string;
  sessionId: string;
  role: string;
  content: unknown;
  metadata?: Record<string, unknown>;
}

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  sequence: number;
  role: string;
  content: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppendAgentToolCallInput {
  id?: string;
  sessionId: string;
  messageId?: string;
  toolName: string;
  status?: AgentToolCallStatus;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AgentToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string;
  sequence: number;
  toolName: string;
  status: AgentToolCallStatus;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  completedAt?: string;
}

export interface CreateAgentInvocationInput {
  id?: string;
  parentSessionId: string;
  childSessionId?: string;
  agentType: string;
  model: string;
  status?: AgentSessionStatus;
  input?: unknown;
}

export interface AgentInvocationRecord {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  sequence: number;
  agentType: string;
  model: string;
  status: AgentSessionStatus;
  input: unknown;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  completedAt?: string;
}

export interface CompleteAgentSessionInput {
  sessionId: string;
  status: Exclude<AgentSessionStatus, 'running'>;
  finalResult?: unknown;
  error?: unknown;
}

export interface CompleteAgentInvocationInput {
  invocationId: string;
  status: Exclude<AgentSessionStatus, 'running'>;
  result?: unknown;
  error?: unknown;
  childSessionId?: string;
}

export interface AgentSessionTree extends AgentSessionRecord {
  messages: AgentMessageRecord[];
  toolCalls: AgentToolCallRecord[];
  invocations: Array<AgentInvocationRecord & { childSession?: AgentSessionTree }>;
}

export interface AgentInvocationTranscript {
  invocation: AgentInvocationRecord;
  childSession?: AgentSessionTree;
}
