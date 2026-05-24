export type KernelTaskKind = 'skill' | 'subagent';

export interface KernelTask {
  kind: KernelTaskKind;
  name: string;
  input?: Record<string, unknown>;
}

export interface KernelDelegationPacket {
  goal: string;
  parentTaskName: string;
  input: Record<string, unknown>;
  parentSessionId: string;
  parentRunId: string;
  contextSummary?: string;
}

export interface KernelTaskDefinition {
  kind: KernelTaskKind;
  name: string;
  description: string;
  resumable?: boolean;
}

export type KernelAgentSource = 'built-in' | 'custom' | 'plugin';

export interface KernelSubagentDefinition<TState> extends KernelTaskDefinition {
  kind: 'subagent';
  name: string;
  source: KernelAgentSource;
  whenToUse: string;
  tags?: string[];
  modelRole?: string;
  maxTurns?: number;
  background?: boolean;
  execute(
    task: KernelTask,
    context: KernelAgentExecutionContext<TState>
  ): Promise<KernelHandlerResult<TState> | undefined>;
}

export interface KernelCheckpoint<TState> {
  state: TState;
  pendingTasks: KernelTask[];
  stopReason?: string;
}

export interface KernelSessionRecord {
  id: string;
  scopeType: 'pull_request' | 'commit';
  scopeKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
}

export interface KernelSessionEventRecord {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface KernelSubagentContextRecord {
  agentId: string;
  parentSessionId: string;
  agentType: 'subagent';
  subagentName: string;
  source: KernelAgentSource;
  invocationKind: 'spawn' | 'resume';
}

export interface KernelSubagentInvocationRecord {
  id: string;
  parentSessionId: string;
  parentRunId: string;
  parentTaskName: string;
  subagentName: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  input: KernelDelegationPacket;
  result?: KernelSubagentInvocationResult;
  startedAt: string;
  finishedAt?: string;
}

export interface KernelSubagentInvocationResult {
  agentId: string;
  agentType: string;
  summary: string;
  totalDurationMs: number;
  totalToolUseCount: number;
  totalTokens: number;
  artifacts?: Record<string, unknown>;
}

export interface KernelExecutionContext<TState> {
  session: KernelSessionRecord;
  runId: string;
  state: TState;
}

export interface KernelAgentExecutionContext<TState> extends KernelExecutionContext<TState> {
  agent: KernelSubagentDefinition<TState>;
  delegation: KernelDelegationPacket;
}

export interface KernelPlanningContext<TState> extends KernelExecutionContext<TState> {
  pendingTasks: KernelTask[];
}

export interface KernelHandlerResult<TState> {
  state?: TState;
  enqueue?: KernelTask[];
  prepend?: KernelTask[];
  stopReason?: string;
  summary?: string;
  artifacts?: Record<string, unknown>;
}

export interface KernelTaskHandler<TState> extends KernelTaskDefinition {
  execute(
    task: KernelTask,
    context: KernelExecutionContext<TState>
  ): Promise<KernelHandlerResult<TState> | undefined>;
}

export interface KernelTurnPlanner<TState> {
  plan(context: KernelPlanningContext<TState>): KernelTask[];
}
