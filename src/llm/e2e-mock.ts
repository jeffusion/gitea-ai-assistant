import type { MainAgentModelClient } from '../agent-kernel/loop';
import type { LLMChatRequest, LLMChatResponse, LLMToolCall } from './types';

export interface MockLLMScriptTurn {
  content?: string | null;
  toolCalls?: LLMToolCall[];
  finishReason?: LLMChatResponse['finishReason'];
  usage?: LLMChatResponse['usage'];
}

export interface MockLLMScriptStep {
  session: string;
  turn: MockLLMScriptTurn;
}

export interface MockLLMCallRecord {
  session: string;
  request: LLMChatRequest;
  response: LLMChatResponse;
}

export interface ScriptedMockLLMOptions {
  steps: MockLLMScriptStep[];
  resolveSession?: (request: LLMChatRequest) => string;
}

const DEFAULT_USAGE: LLMChatResponse['usage'] = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

function cloneTurn(turn: MockLLMScriptTurn): MockLLMScriptTurn {
  return {
    content: turn.content ?? null,
    toolCalls: structuredClone(turn.toolCalls ?? []),
    finishReason: turn.finishReason,
    usage: turn.usage ? structuredClone(turn.usage) : undefined,
  };
}

export function scriptedTurn(turn: MockLLMScriptTurn): MockLLMScriptTurn {
  return cloneTurn(turn);
}

export class ScriptedMockLLM implements MainAgentModelClient {
  private readonly resolveSession: (request: LLMChatRequest) => string;
  private readonly queues: Map<string, MockLLMScriptTurn[]>;
  readonly calls: MockLLMCallRecord[] = [];

  constructor(options: ScriptedMockLLMOptions) {
    this.resolveSession =
      options.resolveSession ??
      ((request) => {
        const userMessage = [...request.messages]
          .reverse()
          .find((message) => message.role === 'user');
        const marker = userMessage?.content.match(/^\[session:([^\]]+)\]/);
        return marker?.[1] ?? 'main';
      });

    this.queues = new Map();
    for (const step of options.steps) {
      const queue = this.queues.get(step.session) ?? [];
      queue.push(cloneTurn(step.turn));
      this.queues.set(step.session, queue);
    }
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const session = this.resolveSession(request);
    const queue = this.queues.get(session) ?? [];
    const turn = queue.shift();
    this.queues.set(session, queue);

    if (!turn) {
      throw new Error(`No scripted mock turn queued for session '${session}'`);
    }

    const response: LLMChatResponse = {
      content: turn.content ?? null,
      toolCalls: turn.toolCalls ?? [],
      finishReason:
        turn.finishReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'),
      usage: turn.usage ?? DEFAULT_USAGE,
    };

    this.calls.push({
      session,
      request: structuredClone(request),
      response: structuredClone(response),
    });

    return response;
  }

  assertExhausted(): void {
    for (const [session, queue] of this.queues.entries()) {
      if (queue.length > 0) {
        throw new Error(
          `Scripted mock still has ${queue.length} pending turn(s) for session '${session}'`
        );
      }
    }
  }

  toolCallSequence(session?: string): string[] {
    return this.calls
      .filter((record) => (session ? record.session === session : true))
      .flatMap((record) => record.response.toolCalls.map((toolCall) => toolCall.name));
  }
}
