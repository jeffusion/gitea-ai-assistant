import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from '../../llm/types';
import type {
  AgentMessageRecord,
  AgentSessionRecord,
  AgentToolCallRecord,
  CreateAgentSessionInput,
} from '../session/types';

export type MainAgentTerminalStatus =
  | 'completed'
  | 'max_turns_reached'
  | 'max_tool_calls_reached'
  | 'max_subagents_reached'
  | 'timeout_reached'
  | 'max_empty_responses'
  | 'max_consecutive_tool_failures';

export interface MainAgentModelClient {
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
}

export interface MainAgentToolContext {
  sessionId: string;
  model: string;
  toolCall: LLMToolCall;
  turn: number;
}

export type ToolPermissionScope =
  | 'read'
  | 'write'
  | 'command'
  | 'network'
  | 'git_write'
  | 'cross_session';

export type ToolPermissionBehavior = 'allow' | 'deny';

export interface MainAgentTool {
  definition: LLMToolDefinition;
  permissionScope?: ToolPermissionScope;
  execute(argumentsValue: unknown, context: MainAgentToolContext): Promise<unknown> | unknown;
}

export interface MainAgentTranscriptRepository {
  createSession(input: CreateAgentSessionInput): AgentSessionRecord;
  appendMessage(input: {
    sessionId: string;
    role: string;
    content: unknown;
    metadata?: Record<string, unknown>;
  }): AgentMessageRecord;
  appendToolCall(input: {
    sessionId: string;
    messageId?: string;
    toolName: string;
    status?: 'running' | 'completed' | 'failed';
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
  }): AgentToolCallRecord;
  completeSession(input: {
    sessionId: string;
    status: 'completed' | 'failed' | 'cancelled';
    finalResult?: unknown;
    error?: unknown;
  }): AgentSessionRecord;
}

export interface MainAgentRunnerOptions {
  modelClient: MainAgentModelClient;
  transcriptRepository: MainAgentTranscriptRepository;
  tools?: MainAgentTool[];
  now?: () => number;
}

export interface MainAgentRunInput {
  session?: Omit<CreateAgentSessionInput, 'model'> & { model?: string };
  sessionId?: string;
  agentType?: string;
  model: string;
  systemPrompt?: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  providerOptions?: Record<string, unknown>;
  maxTurns: number;
  maxToolCalls: number;
  maxSubagents?: number;
  timeoutMs: number;
  maxEmptyResponses?: number;
  maxConsecutiveToolFailures?: number;
}

export interface MainAgentRunResult {
  status: MainAgentTerminalStatus;
  sessionId: string;
  turns: number;
  toolCalls: number;
  finalText?: string;
  messages: LLMMessage[];
}

export interface ToolExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name: string;
    message: string;
  };
}
