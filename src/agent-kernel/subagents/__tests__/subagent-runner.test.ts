import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, initDatabase } from '../../../db/database';
import type { LLMChatRequest, LLMChatResponse } from '../../../llm/types';
import type { AgentDefinition } from '../../definitions';
import type { MainAgentModelClient, MainAgentTool, MainAgentToolContext } from '../../loop';
import { agentSessionRepository } from '../../session';
import type { SpawnSubagentExecutionInput } from '../../tools';
import { SubagentRunner } from '../subagent-runner';

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

const parentOnlyTool: MainAgentTool = {
  definition: {
    name: 'parent_only',
    description: 'A parent-only tool that must not leak into subagents.',
    parameters: { type: 'object' },
  },
  execute: () => ({ leaked: true }),
};

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'general-purpose',
    name: 'General Purpose',
    whenToUse: 'Use for general delegated work.',
    source: 'built-in',
    tools: [],
    disallowedTools: [],
    skills: [],
    hooks: {},
    maxTurns: 4,
    permissionMode: 'default',
    background: false,
    isolation: 'none',
    ...overrides,
  };
}

function parentContext(sessionId: string): MainAgentToolContext {
  return {
    sessionId,
    model: 'main-model',
    turn: 1,
    toolCall: {
      id: 'call-spawn-1',
      name: 'spawn_subagent',
      arguments: '{}',
    },
  };
}

function executionInput(
  sessionId: string,
  overrides: Partial<SpawnSubagentExecutionInput> = {}
): SpawnSubagentExecutionInput {
  const definition = overrides.agentDefinition ?? agentDefinition();
  return {
    agentDefinition: definition,
    agentType: definition.agentType,
    model: 'subagent-model',
    description: 'Investigate issue',
    prompt: 'Use lookup, then summarize.',
    isolation: 'none',
    parent: parentContext(sessionId),
    ...overrides,
  };
}

describe('SubagentRunner', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `subagent-runner-test-${randomUUID()}`);
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

  test('runs an isolated child loop and links invocation to the child session', async () => {
    const parent = agentSessionRepository.createSession({
      agentType: 'main',
      model: 'main-model',
      metadata: { subagentDepth: 0 },
    });
    agentSessionRepository.appendMessage({
      sessionId: parent.id,
      role: 'user',
      content: { text: 'parent prompt only' },
    });
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-lookup-1', name: 'lookup', arguments: '{"query":"alpha"}' }],
      }),
      response({ content: 'child concise summary' }),
    ]);
    const runner = new SubagentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool],
    });

    const result = await runner.execute(
      executionInput(parent.id, { agentDefinition: agentDefinition({ tools: ['lookup'] }) })
    );

    expect(result).toEqual({
      status: 'completed',
      summary: 'child concise summary',
      messagesCount: 4,
      toolCallCount: 1,
      artifacts: { invocationId: expect.any(String) },
    });
    expect(result).not.toHaveProperty('messages');
    expect(result).not.toHaveProperty('toolCalls');
    expect(result).not.toHaveProperty('sessionId');
    expect(result).not.toHaveProperty('totalTokens');

    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.messages).toHaveLength(1);
    expect(tree?.messages[0].content).toEqual({ text: 'parent prompt only' });
    expect(tree?.toolCalls).toHaveLength(0);
    expect(tree?.invocations).toHaveLength(1);
    expect(tree?.invocations[0]).toMatchObject({
      parentSessionId: parent.id,
      childSessionId: tree?.invocations[0].childSessionId,
      agentType: 'general-purpose',
      model: 'subagent-model',
      status: 'completed',
    });
    expect(result.artifacts?.invocationId).toBe(tree?.invocations[0].id);
    expect(tree?.invocations[0].result).toEqual(result);
    const invocationTranscript = agentSessionRepository.getInvocationTranscript(
      tree?.invocations[0].id ?? 'missing'
    );
    expect(invocationTranscript?.invocation.result).toEqual(result);
    expect(invocationTranscript?.childSession?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(invocationTranscript?.childSession?.toolCalls[0]).toMatchObject({
      toolName: 'lookup',
      result: { echoed: 'alpha' },
    });
    expect(tree?.invocations[0].childSession?.parentSessionId).toBe(parent.id);
    expect(tree?.invocations[0].childSession?.parentInvocationId).toBe(tree?.invocations[0].id);
    expect(tree?.invocations[0].childSession?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(tree?.invocations[0].childSession?.toolCalls[0]).toMatchObject({
      toolName: 'lookup',
      result: { echoed: 'alpha' },
    });
    expect(tree?.invocations[0].input).toMatchObject({
      toolPermissions: {
        allowedToolNames: ['lookup'],
        deniedToolNames: [],
      },
    });
    expect(tree?.invocations[0].childSession?.metadata).toMatchObject({
      toolPermissions: {
        allowedToolNames: ['lookup'],
        deniedToolNames: [],
      },
    });
  });

  test('does not leak parent tools into the child model tool definitions', async () => {
    const parent = agentSessionRepository.createSession({ agentType: 'main', model: 'main-model' });
    const modelClient = new FakeModelClient([response({ content: 'no tool needed' })]);
    const runner = new SubagentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [lookupTool, parentOnlyTool],
    });

    const result = await runner.execute(
      executionInput(parent.id, { agentDefinition: agentDefinition({ tools: ['lookup'] }) })
    );

    expect(result.status).toBe('completed');
    expect(modelClient.requests[0].tools?.map((tool) => tool.name)).toEqual(['lookup']);
    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.invocations[0].input).toMatchObject({
      toolPermissions: {
        allowedToolNames: ['lookup'],
        deniedToolNames: ['parent_only'],
      },
    });
  });

  test('persists denied child tool calls as failed unregistered tool calls', async () => {
    const parent = agentSessionRepository.createSession({ agentType: 'main', model: 'main-model' });
    let lookupExecutions = 0;
    const countedLookupTool: MainAgentTool = {
      ...lookupTool,
      execute: () => {
        lookupExecutions += 1;
        return { shouldNotRun: true };
      },
    };
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-denied-lookup', name: 'lookup', arguments: '{"query":"blocked"}' }],
      }),
      response({ content: 'saw permission error and stopped' }),
    ]);
    const runner = new SubagentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [countedLookupTool],
    });

    const result = await runner.execute(
      executionInput(parent.id, { agentDefinition: agentDefinition({ tools: [] }) })
    );

    expect(result.status).toBe('completed');
    expect(result.toolCallCount).toBe(1);
    expect(lookupExecutions).toBe(0);
    expect(modelClient.requests[0].tools).toEqual([]);
    expect(modelClient.requests[1].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call-denied-lookup',
      content: JSON.stringify({
        ok: false,
        error: {
          name: 'ToolNotFoundError',
          message: "Tool 'lookup' is not registered",
        },
      }),
    });

    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.invocations[0].childSession?.toolCalls[0]).toMatchObject({
      toolName: 'lookup',
      status: 'failed',
      arguments: { query: 'blocked' },
      error: {
        name: 'ToolNotFoundError',
        message: "Tool 'lookup' is not registered",
      },
    });
    expect(tree?.invocations[0].childSession?.metadata).toMatchObject({
      toolPermissions: {
        allowedToolNames: [],
        deniedToolNames: ['lookup'],
      },
    });
  });

  test('passes model prompt budgets and optional system prompt to MainAgentRunner', async () => {
    const parent = agentSessionRepository.createSession({ agentType: 'main', model: 'main-model' });
    const modelClient = new FakeModelClient([response({ content: 'system-aware result' })]);
    const runner = new SubagentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      defaultMaxToolCalls: 3,
      defaultTimeoutMs: 30_000,
    });

    const result = await runner.execute(
      executionInput(parent.id, {
        agentDefinition: agentDefinition({
          agentType: 'code-auditor',
          model: 'definition-model',
          maxTurns: 2,
          getSystemPrompt: () => 'subagent system prompt',
        }),
        agentType: 'code-auditor',
        model: 'override-model',
        prompt: 'Audit deterministically.',
      })
    );

    expect(result.status).toBe('completed');
    expect(modelClient.requests[0]).toMatchObject({
      model: 'override-model',
      messages: [
        { role: 'system', content: 'subagent system prompt' },
        { role: 'user', content: 'Audit deterministically.' },
      ],
    });
  });

  test('completes invocation with structured failure when child loop throws', async () => {
    const parent = agentSessionRepository.createSession({ agentType: 'main', model: 'main-model' });
    const runner = new SubagentRunner({
      modelClient: new FakeModelClient([]),
      transcriptRepository: agentSessionRepository,
    });

    const result = await runner.execute(executionInput(parent.id));

    expect(result).toMatchObject({
      status: 'failed',
      summary: 'No fake model response queued',
      messagesCount: 0,
      toolCallCount: 0,
      error: { code: 'Error', message: 'No fake model response queued' },
    });
    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.invocations[0].status).toBe('failed');
    expect(tree?.invocations[0].error).toEqual(result.error);
    expect(tree?.invocations[0].childSession?.status).toBe('failed');
  });

  test('blocks execution and returns structured error when recursion depth exceeds limit', async () => {
    const parent = agentSessionRepository.createSession({
      agentType: 'general-purpose',
      model: 'subagent-model',
      metadata: { subagentDepth: 1 },
    });
    const modelClient = new FakeModelClient([response({ content: 'must not be used' })]);
    const runner = new SubagentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      maxDepth: 1,
    });

    const result = await runner.execute(executionInput(parent.id));

    expect(result).toEqual({
      status: 'failed',
      summary: 'Subagent recursion depth limit exceeded (1).',
      messagesCount: 0,
      toolCallCount: 0,
      artifacts: { invocationId: expect.any(String) },
      error: {
        code: 'recursion_depth_exceeded',
        message: 'Subagent recursion depth 2 exceeds max depth 1.',
      },
    });
    expect(modelClient.requests).toHaveLength(0);
    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.invocations[0]).toMatchObject({
      status: 'failed',
      childSessionId: undefined,
      result,
      error: result.error,
    });
    expect(tree?.invocations[0].childSession).toBeUndefined();
  });
});
