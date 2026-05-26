import type { LLMMessage, LLMToolCall } from '../../llm/types';
import { agentSessionRepository } from '../session/session-repository';
import type {
  MainAgentRunInput,
  MainAgentRunResult,
  MainAgentRunnerOptions,
  MainAgentTerminalStatus,
  MainAgentTool,
  MainAgentTranscriptRepository,
  ToolExecutionResult,
} from './types';

function parseToolArguments(toolCall: LLMToolCall): ToolExecutionResult {
  try {
    return { ok: true, value: JSON.parse(toolCall.arguments || '{}') };
  } catch (error) {
    const parsedError = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      error: {
        name: parsedError.name,
        message: parsedError.message,
      },
    };
  }
}

function stringifyToolResult(result: ToolExecutionResult): string {
  return JSON.stringify(result);
}

function normalizeError(error: unknown): ToolExecutionResult['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

export class MainAgentRunner {
  private readonly modelClient: MainAgentRunnerOptions['modelClient'];
  private readonly transcriptRepository: MainAgentTranscriptRepository;
  private readonly toolsByName: Map<string, MainAgentTool>;
  private readonly now: () => number;

  constructor(options: MainAgentRunnerOptions) {
    this.modelClient = options.modelClient;
    this.transcriptRepository = options.transcriptRepository;
    this.toolsByName = new Map((options.tools ?? []).map((tool) => [tool.definition.name, tool]));
    this.now = options.now ?? Date.now;
  }

  async run(input: MainAgentRunInput): Promise<MainAgentRunResult> {
    const startedAt = this.now();
    const sessionId =
      input.sessionId ??
      this.transcriptRepository.createSession({
        agentType: input.session?.agentType ?? input.agentType ?? 'main',
        model: input.session?.model ?? input.model,
        parentSessionId: input.session?.parentSessionId,
        parentInvocationId: input.session?.parentInvocationId,
        status: input.session?.status,
        metadata: input.session?.metadata,
      }).id;

    const messages: LLMMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }

    const userMessage: LLMMessage = { role: 'user', content: input.userMessage };
    messages.push(userMessage);
    this.transcriptRepository.appendMessage({
      sessionId,
      role: 'user',
      content: { text: input.userMessage },
    });

    let turns = 0;
    let toolCalls = 0;
    let subagentCount = 0;
    let emptyResponseCount = 0;
    let consecutiveToolFailures = 0;
    const maxSubagents = input.maxSubagents ?? Number.POSITIVE_INFINITY;
    const maxEmptyResponses = input.maxEmptyResponses ?? 3;
    const maxConsecutiveToolFailures = input.maxConsecutiveToolFailures ?? 5;

    while (true) {
      const budgetStatus = this.getBudgetStatus(
        input,
        startedAt,
        turns,
        emptyResponseCount,
        consecutiveToolFailures,
        maxEmptyResponses,
        maxConsecutiveToolFailures
      );
      if (budgetStatus) {
        return this.finish(sessionId, budgetStatus, turns, toolCalls, messages);
      }

      const response = await this.modelClient.chat({
        messages,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat: input.responseFormat,
        providerOptions: input.providerOptions,
        tools: [...this.toolsByName.values()].map((tool) => tool.definition),
      });

      turns += 1;

      if (!response.content?.trim() && response.toolCalls.length === 0) {
        emptyResponseCount += 1;
        messages.push({ role: 'assistant', content: '' });
        this.transcriptRepository.appendMessage({
          sessionId,
          role: 'assistant',
          content: { text: '' },
        });
        continue;
      }

      emptyResponseCount = 0;

      const assistantMessage: LLMMessage = {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMessage);

      const assistantRecord = this.transcriptRepository.appendMessage({
        sessionId,
        role: 'assistant',
        content: {
          text: response.content ?? '',
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          usage: response.usage,
        },
      });

      if (response.toolCalls.length === 0) {
        return this.finish(
          sessionId,
          'completed',
          turns,
          toolCalls,
          messages,
          response.content ?? undefined
        );
      }

      for (const toolCall of response.toolCalls) {
        if (this.isTimedOut(input, startedAt)) {
          return this.finish(sessionId, 'timeout_reached', turns, toolCalls, messages);
        }
        if (toolCalls >= input.maxToolCalls) {
          return this.finish(sessionId, 'max_tool_calls_reached', turns, toolCalls, messages);
        }

        if (toolCall.name === 'spawn_subagent') {
          if (subagentCount >= maxSubagents) {
            const refusalMessage: LLMMessage = {
              role: 'tool',
              toolCallId: toolCall.id,
              content: JSON.stringify({
                ok: false,
                error: {
                  name: 'BudgetExceeded',
                  message: `Subagent limit reached (${maxSubagents}). Please summarize your findings instead.`,
                },
              }),
            };
            messages.push(refusalMessage);
            this.transcriptRepository.appendMessage({
              sessionId,
              role: 'tool',
              content: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: {
                  ok: false,
                  error: {
                    name: 'BudgetExceeded',
                    message: `Subagent limit reached (${maxSubagents})`,
                  },
                },
              },
            });
            continue;
          }
          subagentCount += 1;
        }

        const result = await this.executeTool(toolCall, sessionId, input.model, turns);
        toolCalls += 1;
        if (!result.ok) {
          consecutiveToolFailures += 1;
        } else {
          consecutiveToolFailures = 0;
        }

        if (!result.ok && consecutiveToolFailures >= maxConsecutiveToolFailures) {
          return this.finish(
            sessionId,
            'max_consecutive_tool_failures',
            turns,
            toolCalls,
            messages
          );
        }

        this.transcriptRepository.appendToolCall({
          sessionId,
          messageId: assistantRecord.id,
          toolName: toolCall.name,
          status: result.ok ? 'completed' : 'failed',
          arguments: parseToolArguments(toolCall).value ?? {},
          result: result.ok ? result.value : undefined,
          error: result.ok ? undefined : result.error,
        });

        const toolMessage: LLMMessage = {
          role: 'tool',
          toolCallId: toolCall.id,
          content: stringifyToolResult(result),
        };
        messages.push(toolMessage);
        this.transcriptRepository.appendMessage({
          sessionId,
          role: 'tool',
          content: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
          },
        });
      }
    }
  }

  private getBudgetStatus(
    input: MainAgentRunInput,
    startedAt: number,
    turns: number,
    emptyResponseCount: number,
    consecutiveToolFailures: number,
    maxEmptyResponses: number,
    maxConsecutiveToolFailures: number
  ): MainAgentTerminalStatus | undefined {
    if (this.isTimedOut(input, startedAt)) return 'timeout_reached';
    if (turns >= input.maxTurns) return 'max_turns_reached';
    if (emptyResponseCount >= maxEmptyResponses) return 'max_empty_responses';
    if (consecutiveToolFailures >= maxConsecutiveToolFailures)
      return 'max_consecutive_tool_failures';
    return undefined;
  }

  private isTimedOut(input: MainAgentRunInput, startedAt: number): boolean {
    return this.now() - startedAt >= input.timeoutMs;
  }

  private async executeTool(
    toolCall: LLMToolCall,
    sessionId: string,
    model: string,
    turn: number
  ): Promise<ToolExecutionResult> {
    const parsedArguments = parseToolArguments(toolCall);
    if (!parsedArguments.ok) return parsedArguments;

    const tool = this.toolsByName.get(toolCall.name);
    if (!tool) {
      return {
        ok: false,
        error: {
          name: 'ToolNotFoundError',
          message: `Tool '${toolCall.name}' is not registered`,
        },
      };
    }

    try {
      const value = await tool.execute(parsedArguments.value, {
        sessionId,
        model,
        toolCall,
        turn,
      });
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: normalizeError(error),
      };
    }
  }

  private finish(
    sessionId: string,
    status: MainAgentTerminalStatus,
    turns: number,
    toolCalls: number,
    messages: LLMMessage[],
    finalText?: string
  ): MainAgentRunResult {
    this.transcriptRepository.completeSession({
      sessionId,
      status: status === 'completed' ? 'completed' : 'failed',
      finalResult: {
        status,
        turns,
        toolCalls,
        finalText,
      },
      error: status === 'completed' ? undefined : { status },
    });

    return {
      status,
      sessionId,
      turns,
      toolCalls,
      finalText,
      messages,
    };
  }
}

export const mainAgentRunner = new MainAgentRunner({
  modelClient: {
    chat: () => {
      throw new Error('MainAgentRunner requires an injected model client');
    },
  },
  transcriptRepository: agentSessionRepository,
});
