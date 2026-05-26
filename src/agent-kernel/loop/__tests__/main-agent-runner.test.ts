import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, initDatabase } from '../../../db/database';
import type { LLMChatRequest, LLMChatResponse } from '../../../llm/types';
import { agentSessionRepository } from '../../session/session-repository';
import { MainAgentRunner } from '../main-agent-runner';
import type { MainAgentModelClient, MainAgentTool } from '../types';

function response(partial: Partial<LLMChatResponse>): LLMChatResponse {
  return {
    content: partial.content ?? null,
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? 'stop',
    usage: partial.usage ?? {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
  };
}

class FakeModelClient implements MainAgentModelClient {
  requests: LLMChatRequest[] = [];

  constructor(private readonly responses: LLMChatResponse[]) {}

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (!next) throw new Error('No fake model response queued');
    return next;
  }
}

const lookupTool: MainAgentTool = {
  definition: {
    name: 'lookup',
    description: 'Look up a deterministic value.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  execute: (argumentsValue) => ({ echoed: (argumentsValue as { query: string }).query }),
};

describe('MainAgentRunner', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `main-agent-runner-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  test('runs tool call, appends tool result, then returns final answer', async () => {
    const modelClient = new FakeModelClient([
      response({
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"query":"alpha"}' }],
      }),
      response({ content: 'final answer' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool],
    });

    const result = await runner.run({
      agentType: 'main',
      model: 'mock-model',
      userMessage: 'answer with a tool',
      maxTurns: 4,
      maxToolCalls: 4,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('final answer');
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(modelClient.requests[1].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call-1',
      content: JSON.stringify({ ok: true, value: { echoed: 'alpha' } }),
    });

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(tree?.toolCalls[0].result).toEqual({ echoed: 'alpha' });
    expect(tree?.finalResult).toEqual({
      status: 'completed',
      turns: 2,
      toolCalls: 1,
      finalText: 'final answer',
    });
  });

  test('completes on final assistant answer with no tool calls', async () => {
    const runner = new MainAgentRunner({
      modelClient: new FakeModelClient([response({ content: 'plain final' })]),
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'answer directly',
      maxTurns: 2,
      maxToolCalls: 2,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(result.toolCalls).toBe(0);
    expect(agentSessionRepository.getSessionTree(result.sessionId)?.messages).toHaveLength(2);
  });

  test('stops runaway model at max turns', async () => {
    const runner = new MainAgentRunner({
      modelClient: new FakeModelClient([
        response({
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"query":"one"}' }],
        }),
        response({
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-2', name: 'lookup', arguments: '{"query":"two"}' }],
        }),
      ]),
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'keep calling tools',
      maxTurns: 2,
      maxToolCalls: 10,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('max_turns_reached');
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(agentSessionRepository.getSessionTree(result.sessionId)?.status).toBe('failed');
  });

  test('stops before exceeding max tool calls', async () => {
    const runner = new MainAgentRunner({
      modelClient: new FakeModelClient([
        response({
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'call-1', name: 'lookup', arguments: '{"query":"one"}' },
            { id: 'call-2', name: 'lookup', arguments: '{"query":"two"}' },
          ],
        }),
      ]),
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'too many tools',
      maxTurns: 4,
      maxToolCalls: 1,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('max_tool_calls_reached');
    expect(result.toolCalls).toBe(1);
    expect(agentSessionRepository.getSessionTree(result.sessionId)?.toolCalls).toHaveLength(1);
  });

  test('records tool execution errors as structured tool results and continues', async () => {
    const failingTool: MainAgentTool = {
      definition: {
        name: 'fail_lookup',
        description: 'Always fails.',
        parameters: { type: 'object' },
      },
      execute: () => {
        throw new Error('lookup failed');
      },
    };
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: 'fail_lookup', arguments: '{}' }],
      }),
      response({ content: 'recovered' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [failingTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'recover from tool error',
      maxTurns: 4,
      maxToolCalls: 2,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.toolCalls[0].status).toBe('failed');
    expect(tree?.toolCalls[0].error).toEqual({ name: 'Error', message: 'lookup failed' });
    expect(modelClient.requests[1].messages.at(-1)?.content).toBe(
      JSON.stringify({ ok: false, error: { name: 'Error', message: 'lookup failed' } })
    );
  });

  test('stops on maxEmptyResponses', async () => {
    const modelClient = new FakeModelClient([
      response({ content: '' }),
      response({ content: '' }),
      response({ content: 'should not reach' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'test empty responses',
      maxTurns: 10,
      maxToolCalls: 10,
      timeoutMs: 60_000,
      maxEmptyResponses: 2,
    });

    expect(result.status).toBe('max_empty_responses');
    expect(result.turns).toBe(2);
  });

  test('stops on maxConsecutiveToolFailures', async () => {
    const failTool: MainAgentTool = {
      definition: {
        name: 'fail_tool',
        description: 'Always fails.',
        parameters: { type: 'object' },
      },
      execute: () => {
        throw new Error('boom');
      },
    };
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'fail_tool', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'fail_tool', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c3', name: 'fail_tool', arguments: '{}' }],
      }),
      response({ content: 'should not reach' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [failTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'test tool failures',
      maxTurns: 10,
      maxToolCalls: 10,
      timeoutMs: 60_000,
      maxConsecutiveToolFailures: 3,
    });

    expect(result.status).toBe('max_consecutive_tool_failures');
  });

  test('refuses subagent spawn beyond maxSubagents and allows summary', async () => {
    const subagentTool: MainAgentTool = {
      definition: {
        name: 'spawn_subagent',
        description: 'Spawn a subagent.',
        parameters: { type: 'object' },
      },
      execute: () => ({ status: 'completed' }),
    };
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'spawn_subagent', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'spawn_subagent', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c3', name: 'spawn_subagent', arguments: '{}' }],
      }),
      response({ content: 'review complete with 2 subagents' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [subagentTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: 'test subagent limit',
      maxTurns: 10,
      maxToolCalls: 10,
      timeoutMs: 60_000,
      maxSubagents: 2,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('review complete with 2 subagents');
  });
});
