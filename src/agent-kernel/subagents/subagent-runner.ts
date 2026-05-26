import { MainAgentRunner } from '../loop';
import type {
  MainAgentModelClient,
  MainAgentTerminalStatus,
  MainAgentTool,
  MainAgentTranscriptRepository,
} from '../loop';
import type {
  AgentInvocationRecord,
  AgentMessageRecord,
  CompleteAgentInvocationInput,
  CreateAgentInvocationInput,
} from '../session';
import type { AgentSessionRecord } from '../session';
import { resolveAgentTools } from '../tools';
import type { SpawnSubagentExecutionInput, SpawnSubagentExecutor } from '../tools';
import type { SubagentResult } from './subagent-result';

export interface SubagentRunnerTranscriptRepository extends MainAgentTranscriptRepository {
  createInvocation(input: CreateAgentInvocationInput): AgentInvocationRecord;
  completeInvocation(input: CompleteAgentInvocationInput): AgentInvocationRecord;
  getSession?(sessionId: string): AgentSessionRecord | null;
  listMessages?(sessionId: string): AgentMessageRecord[];
}

export interface SubagentRunnerOptions {
  modelClient: MainAgentModelClient;
  transcriptRepository: SubagentRunnerTranscriptRepository;
  tools?: MainAgentTool[];
  defaultMaxTurns?: number;
  defaultMaxToolCalls?: number;
  defaultTimeoutMs?: number;
  maxDepth?: number;
  now?: () => number;
}

function isCompletedStatus(status: MainAgentTerminalStatus): boolean {
  return status === 'completed';
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name, message: error.message };
  }
  return { code: 'Error', message: String(error) };
}

function readDepth(session: AgentSessionRecord | null | undefined): number {
  const value = session?.metadata.subagentDepth;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readTotalTokens(messages: AgentMessageRecord[]): number | undefined {
  let totalTokens = 0;
  let foundUsage = false;

  for (const message of messages) {
    const content = message.content;
    if (typeof content !== 'object' || content === null || !('usage' in content)) continue;

    const usage = (content as { usage?: unknown }).usage;
    if (typeof usage !== 'object' || usage === null || !('totalTokens' in usage)) continue;

    const value = (usage as { totalTokens?: unknown }).totalTokens;
    if (typeof value !== 'number') continue;

    totalTokens += value;
    foundUsage = true;
  }

  return foundUsage ? totalTokens : undefined;
}

export class SubagentRunner implements SpawnSubagentExecutor {
  private readonly modelClient: MainAgentModelClient;
  private readonly transcriptRepository: SubagentRunnerTranscriptRepository;
  private readonly tools: MainAgentTool[];
  private readonly defaultMaxTurns: number;
  private readonly defaultMaxToolCalls: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxDepth: number;
  private readonly now?: () => number;

  constructor(options: SubagentRunnerOptions) {
    this.modelClient = options.modelClient;
    this.transcriptRepository = options.transcriptRepository;
    this.tools = options.tools ?? [];
    this.defaultMaxTurns = options.defaultMaxTurns ?? 4;
    this.defaultMaxToolCalls = options.defaultMaxToolCalls ?? 8;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxDepth = options.maxDepth ?? 3;
    this.now = options.now;
  }

  async execute(input: SpawnSubagentExecutionInput): Promise<SubagentResult> {
    const toolPermissions = resolveAgentTools({
      availableTools: this.tools,
      allowedToolNames: input.agentDefinition.tools,
      disallowedToolNames: input.agentDefinition.disallowedTools,
      allowListSpecified: true,
    });

    const invocation = this.transcriptRepository.createInvocation({
      parentSessionId: input.parent.sessionId,
      agentType: input.agentType,
      model: input.model,
      input: {
        description: input.description,
        prompt: input.prompt,
        isolation: input.isolation,
        cwd: input.cwd,
        parentToolCallId: input.parent.toolCall.id,
        toolPermissions: {
          allowedToolNames: toolPermissions.allowedToolNames,
          disallowedToolNames: toolPermissions.disallowedToolNames,
          deniedToolNames: toolPermissions.deniedToolNames,
          unknownAllowedToolNames: toolPermissions.unknownAllowedToolNames,
          unknownDisallowedToolNames: toolPermissions.unknownDisallowedToolNames,
        },
      },
    });

    const parentSession = this.transcriptRepository.getSession?.(input.parent.sessionId);
    const childDepth = readDepth(parentSession) + 1;

    if (childDepth > this.maxDepth) {
      const result: SubagentResult = {
        status: 'failed',
        summary: `Subagent recursion depth limit exceeded (${this.maxDepth}).`,
        messagesCount: 0,
        toolCallCount: 0,
        artifacts: { invocationId: invocation.id },
        error: {
          code: 'recursion_depth_exceeded',
          message: `Subagent recursion depth ${childDepth} exceeds max depth ${this.maxDepth}.`,
        },
      };

      this.transcriptRepository.completeInvocation({
        invocationId: invocation.id,
        status: 'failed',
        result,
        error: result.error,
      });

      return result;
    }

    const childSession = this.transcriptRepository.createSession({
      parentSessionId: input.parent.sessionId,
      parentInvocationId: invocation.id,
      agentType: input.agentType,
      model: input.model,
      metadata: {
        subagentDepth: childDepth,
        description: input.description,
        parentToolCallId: input.parent.toolCall.id,
        toolPermissions: {
          allowedToolNames: toolPermissions.allowedToolNames,
          disallowedToolNames: toolPermissions.disallowedToolNames,
          deniedToolNames: toolPermissions.deniedToolNames,
          unknownAllowedToolNames: toolPermissions.unknownAllowedToolNames,
          unknownDisallowedToolNames: toolPermissions.unknownDisallowedToolNames,
        },
      },
    });

    const runner = new MainAgentRunner({
      modelClient: this.modelClient,
      transcriptRepository: this.transcriptRepository,
      tools: toolPermissions.tools,
      now: this.now,
    });

    try {
      const runResult = await runner.run({
        sessionId: childSession.id,
        agentType: input.agentType,
        model: input.model,
        systemPrompt: input.agentDefinition.getSystemPrompt?.(),
        userMessage: input.prompt,
        maxTurns: input.agentDefinition.maxTurns ?? this.defaultMaxTurns,
        maxToolCalls: this.defaultMaxToolCalls,
        timeoutMs: this.defaultTimeoutMs,
      });
      const totalTokens = this.transcriptRepository.listMessages
        ? readTotalTokens(this.transcriptRepository.listMessages(childSession.id))
        : undefined;

      const result: SubagentResult = {
        status: isCompletedStatus(runResult.status) ? 'completed' : 'failed',
        summary: runResult.finalText ?? runResult.status,
        messagesCount: runResult.messages.length,
        toolCallCount: runResult.toolCalls,
        ...(totalTokens === undefined ? {} : { totalTokens }),
        artifacts: { invocationId: invocation.id },
        ...(isCompletedStatus(runResult.status)
          ? {}
          : {
              error: {
                code: runResult.status,
                message: `Subagent stopped with status ${runResult.status}.`,
              },
            }),
      };

      this.transcriptRepository.completeInvocation({
        invocationId: invocation.id,
        status: result.status,
        result,
        error: result.error,
        childSessionId: childSession.id,
      });

      return result;
    } catch (error) {
      const normalized = normalizeError(error);
      const result: SubagentResult = {
        status: 'failed',
        summary: normalized.message,
        messagesCount: 0,
        toolCallCount: 0,
        artifacts: { invocationId: invocation.id },
        error: normalized,
      };

      this.transcriptRepository.completeSession({
        sessionId: childSession.id,
        status: 'failed',
        error: normalized,
      });
      this.transcriptRepository.completeInvocation({
        invocationId: invocation.id,
        status: 'failed',
        result,
        error: normalized,
        childSessionId: childSession.id,
      });

      return result;
    }
  }
}
