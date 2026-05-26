import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, initDatabase } from '../../../db/database';
import type { LLMChatRequest, LLMChatResponse } from '../../../llm/types';
import { createAgentRegistry } from '../../definitions';
import { MainAgentRunner } from '../../loop';
import type { MainAgentModelClient } from '../../loop';
import { agentSessionRepository } from '../../session/session-repository';
import { createSpawnSubagentTool } from '../spawn-subagent-tool';
import type { SpawnSubagentExecutionInput, SpawnSubagentExecutor } from '../spawn-subagent-tool';

function agent(agentType: string, name: string, model?: string) {
  return {
    agentType,
    name,
    whenToUse: `Use ${name}.`,
    source: 'built-in' as const,
    model,
  };
}

function makeExecutor(result: unknown = { summary: 'subagent done', value: 42 }) {
  const calls: SpawnSubagentExecutionInput[] = [];
  const executor: SpawnSubagentExecutor = {
    execute: (input) => {
      calls.push(input);
      return result;
    },
  };
  return { executor, calls };
}

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

describe('createSpawnSubagentTool', () => {
  test('defaults to general-purpose when subagent_type is omitted', async () => {
    const registry = createAgentRegistry({
      builtIn: [agent('general-purpose', 'General Purpose', 'definition-model')],
    });
    const { executor, calls } = makeExecutor();
    const tool = createSpawnSubagentTool({
      agentRegistry: registry,
      executor,
      defaultSubagentModel: 'default-subagent-model',
    });

    const result = await tool.execute(
      { description: 'Summarize', prompt: 'Summarize the change.' },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toEqual({
      status: 'completed',
      agentType: 'general-purpose',
      model: 'definition-model',
      description: 'Summarize',
      result: { summary: 'subagent done', value: 42 },
      summary: 'subagent done',
    });
    expect(calls[0]).toMatchObject({
      agentType: 'general-purpose',
      model: 'definition-model',
      description: 'Summarize',
      prompt: 'Summarize the change.',
      isolation: 'none',
    });
  });

  test('spawns an explicit active subagent type', async () => {
    const registry = createAgentRegistry({
      builtIn: [
        agent('general-purpose', 'General Purpose'),
        agent('code-reviewer', 'Code Reviewer'),
      ],
    });
    const { executor, calls } = makeExecutor({ summary: 'reviewed' });
    const tool = createSpawnSubagentTool({
      agentRegistry: registry,
      executor,
      defaultSubagentModel: 'default-subagent-model',
    });

    const result = await tool.execute(
      {
        description: 'Review code',
        prompt: 'Review this diff.',
        subagent_type: 'code-reviewer',
        isolation: 'workspace',
        cwd: '/tmp/workspace',
      },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toMatchObject({
      status: 'completed',
      agentType: 'code-reviewer',
      model: 'default-subagent-model',
      description: 'Review code',
      summary: 'reviewed',
    });
    expect(calls[0]).toMatchObject({
      agentType: 'code-reviewer',
      isolation: 'workspace',
      cwd: '/tmp/workspace',
    });
  });

  test('returns a structured error for unknown subagent types', async () => {
    const registry = createAgentRegistry({
      builtIn: [
        agent('general-purpose', 'General Purpose'),
        agent('code-reviewer', 'Code Reviewer'),
      ],
    });
    const { executor, calls } = makeExecutor();
    const tool = createSpawnSubagentTool({ agentRegistry: registry, executor });

    const result = await tool.execute(
      { description: 'Unknown', prompt: 'Run missing agent.', subagent_type: 'missing-agent' },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toEqual({
      status: 'error',
      code: 'unknown_subagent_type',
      message: "Subagent type 'missing-agent' is not active.",
      requestedType: 'missing-agent',
      availableTypes: ['code-reviewer', 'general-purpose'],
    });
    expect(calls).toHaveLength(0);
  });

  test('uses model override before definition and fallback models', async () => {
    const registry = createAgentRegistry({
      builtIn: [agent('general-purpose', 'General Purpose', 'definition-model')],
    });
    const { executor, calls } = makeExecutor();
    const tool = createSpawnSubagentTool({
      agentRegistry: registry,
      executor,
      defaultSubagentModel: 'default-subagent-model',
    });

    const result = await tool.execute(
      { description: 'Override', prompt: 'Use override.', model: 'spawn-model' },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toMatchObject({ status: 'completed', model: 'spawn-model' });
    expect(calls[0].model).toBe('spawn-model');
  });

  test('returns a structured unsupported result for background spawns', async () => {
    const registry = createAgentRegistry({
      builtIn: [agent('general-purpose', 'General Purpose')],
    });
    const { executor, calls } = makeExecutor();
    const tool = createSpawnSubagentTool({ agentRegistry: registry, executor });

    const result = await tool.execute(
      { description: 'Background', prompt: 'Run later.', run_in_background: true },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toEqual({
      status: 'error',
      code: 'background_execution_unsupported',
      message:
        'spawn_subagent background execution is not supported until the isolated SubagentRunner is implemented.',
      requestedType: 'general-purpose',
      availableTypes: ['general-purpose'],
    });
    expect(calls).toHaveLength(0);
  });

  test('returns a structured validation error for missing required arguments', async () => {
    const registry = createAgentRegistry({
      builtIn: [agent('general-purpose', 'General Purpose')],
    });
    const { executor } = makeExecutor();
    const tool = createSpawnSubagentTool({ agentRegistry: registry, executor });

    const result = await tool.execute(
      { description: 'Missing prompt' },
      {
        sessionId: 'parent-session',
        model: 'main-model',
        turn: 1,
        toolCall: { id: 'call-1', name: 'spawn_subagent', arguments: '{}' },
      }
    );

    expect(result).toMatchObject({
      status: 'error',
      code: 'invalid_arguments',
      message: 'spawn_subagent requires non-empty description and prompt arguments.',
    });
  });
});

describe('spawn_subagent MainAgentRunner integration', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `spawn-subagent-tool-test-${randomUUID()}`);
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

  test('executes through MainAgentRunner and persists the parent tool call', async () => {
    const registry = createAgentRegistry({
      builtIn: [agent('general-purpose', 'General Purpose', 'subagent-model')],
    });
    const { executor } = makeExecutor({ summary: 'finished by fake executor', value: 'ok' });
    const tool = createSpawnSubagentTool({ agentRegistry: registry, executor });
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-spawn-1',
            name: 'spawn_subagent',
            arguments: JSON.stringify({
              description: 'Investigate issue',
              prompt: 'Inspect this issue deterministically.',
            }),
          },
        ],
      }),
      response({ content: 'parent final' }),
    ]);
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: agentSessionRepository,
      tools: [tool],
    });

    const result = await runner.run({
      agentType: 'main',
      model: 'main-model',
      userMessage: 'delegate investigation',
      maxTurns: 4,
      maxToolCalls: 4,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(result.toolCalls).toBe(1);
    expect(modelClient.requests[0].tools?.map((definition) => definition.name)).toContain(
      'spawn_subagent'
    );
    expect(modelClient.requests[1].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call-spawn-1',
      content: JSON.stringify({
        ok: true,
        value: {
          status: 'completed',
          agentType: 'general-purpose',
          model: 'subagent-model',
          description: 'Investigate issue',
          result: { summary: 'finished by fake executor', value: 'ok' },
          summary: 'finished by fake executor',
        },
      }),
    });

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.toolCalls).toHaveLength(1);
    expect(tree?.toolCalls[0].toolName).toBe('spawn_subagent');
    expect(tree?.toolCalls[0].arguments).toEqual({
      description: 'Investigate issue',
      prompt: 'Inspect this issue deterministically.',
    });
    expect(tree?.toolCalls[0].result).toEqual({
      status: 'completed',
      agentType: 'general-purpose',
      model: 'subagent-model',
      description: 'Investigate issue',
      result: { summary: 'finished by fake executor', value: 'ok' },
      summary: 'finished by fake executor',
    });
  });
});
