import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, initDatabase } from '../../../db/database';
import { ScriptedMockLLM, scriptedTurn } from '../../../llm/e2e-mock';
import { createAgentRegistry } from '../../definitions';
import { agentSessionRepository } from '../../session';
import { SubagentRunner } from '../../subagents/subagent-runner';
import { createSpawnSubagentTool } from '../../tools';
import { MainAgentRunner } from '../main-agent-runner';
import type { MainAgentTool } from '../types';

function baseAgentDefinition() {
  return {
    agentType: 'general-purpose',
    name: 'General Purpose',
    whenToUse: 'Use for delegated analysis.',
    source: 'built-in' as const,
    tools: ['search_code', 'read_file'],
    disallowedTools: [],
    skills: [],
    hooks: {},
    maxTurns: 6,
    permissionMode: 'default' as const,
    background: false,
    isolation: 'none' as const,
  };
}

describe('Scripted Mock LLM dynamic agent flows', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `dynamic-agent-scripted-mock-${randomUUID()}`);
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

  function makeTools(record: { submissions: unknown[] }) {
    const readFileTool: MainAgentTool = {
      definition: {
        name: 'read_file',
        description: 'Read deterministic test fixture.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      execute: (args) => ({ path: (args as { path: string }).path, content: 'const value = 1;' }),
    };

    const searchCodeTool: MainAgentTool = {
      definition: {
        name: 'search_code',
        description: 'Search deterministic test fixture.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      execute: (args) => ({
        matches: [{ path: 'src/app.ts', line: 1, query: (args as { query: string }).query }],
      }),
    };

    const submitReviewFindingsTool: MainAgentTool = {
      definition: {
        name: 'submit_review_findings',
        description: 'Capture deterministic submission payload.',
        parameters: {
          type: 'object',
          properties: {
            summaryMarkdown: { type: 'string' },
            findings: { type: 'array', items: { type: 'object' } },
          },
          required: ['summaryMarkdown', 'findings'],
        },
      },
      execute: (args) => {
        record.submissions.push(structuredClone(args));
        return { accepted: true };
      },
    };

    return { readFileTool, searchCodeTool, submitReviewFindingsTool };
  }

  test('deterministically scripts main->spawn_subagent->submit_review_findings flow', async () => {
    const scriptedModel = new ScriptedMockLLM({
      resolveSession: (request) => (request.model === 'subagent-model' ? 'subagent' : 'main'),
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'main-read-1', name: 'read_file', arguments: '{"path":"src/app.ts"}' },
            ],
          }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-spawn-1',
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  description: 'Inspect changed file',
                  prompt: 'Check correctness risks.',
                }),
              },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'sub-search-1', name: 'search_code', arguments: '{"query":"value"}' },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'sub-read-1', name: 'read_file', arguments: '{"path":"src/app.ts"}' },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({ content: 'Subagent summary: potential correctness issue found.' }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({ summaryMarkdown: 'Found one issue.', findings: [] }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'Review finalized.' }) },
      ],
    });

    const submissionRecord = { submissions: [] as unknown[] };
    const { readFileTool, searchCodeTool, submitReviewFindingsTool } = makeTools(submissionRecord);

    const subagentRunner = new SubagentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [searchCodeTool, readFileTool],
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({ builtIn: [baseAgentDefinition()] }),
      executor: subagentRunner,
      defaultSubagentModel: 'subagent-model',
    });
    const runner = new MainAgentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [readFileTool, spawnSubagentTool, submitReviewFindingsTool],
    });

    const result = await runner.run({
      model: 'main-model',
      agentType: 'review-main-agent',
      userMessage: 'Start dynamic review.',
      maxTurns: 8,
      maxToolCalls: 8,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Review finalized.');
    expect(scriptedModel.toolCallSequence('main')).toEqual([
      'read_file',
      'spawn_subagent',
      'submit_review_findings',
    ]);
    expect(scriptedModel.toolCallSequence('subagent')).toEqual(['search_code', 'read_file']);

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      'read_file',
      'spawn_subagent',
      'submit_review_findings',
    ]);
    expect(tree?.invocations).toHaveLength(1);
    expect(tree?.invocations[0].status).toBe('completed');
    expect(
      tree?.invocations[0].childSession?.toolCalls.map((toolCall) => toolCall.toolName)
    ).toEqual(['search_code', 'read_file']);
    expect(submissionRecord.submissions).toEqual([
      { summaryMarkdown: 'Found one issue.', findings: [] },
    ]);
    scriptedModel.assertExhausted();
  });

  test('supports deterministic no-subagent completion flow', async () => {
    const scriptedModel = new ScriptedMockLLM({
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'main-read-1', name: 'read_file', arguments: '{"path":"src/app.ts"}' },
            ],
          }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({ summaryMarkdown: 'No issues found.', findings: [] }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'Done without subagent.' }) },
      ],
    });

    const submissionRecord = { submissions: [] as unknown[] };
    const { readFileTool, submitReviewFindingsTool } = makeTools(submissionRecord);
    const runner = new MainAgentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [readFileTool, submitReviewFindingsTool],
    });

    const result = await runner.run({
      model: 'main-model',
      userMessage: 'Review directly.',
      maxTurns: 6,
      maxToolCalls: 6,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(scriptedModel.toolCallSequence('main')).toEqual(['read_file', 'submit_review_findings']);
    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.status).toBe('completed');
    expect(tree?.finalResult).toEqual({
      status: 'completed',
      turns: 3,
      toolCalls: 2,
      finalText: 'Done without subagent.',
    });
    expect(tree?.invocations).toHaveLength(0);
    expect(tree?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      'read_file',
      'submit_review_findings',
    ]);
    expect(submissionRecord.submissions).toEqual([
      { summaryMarkdown: 'No issues found.', findings: [] },
    ]);
    scriptedModel.assertExhausted();
  });

  test('supports multiple subagent spawns in one main run with distinct child sessions', async () => {
    const scriptedModel = new ScriptedMockLLM({
      resolveSession: (request) => (request.model === 'subagent-model' ? 'subagent' : 'main'),
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-spawn-1',
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  description: 'Run child one',
                  prompt: 'Inspect alpha path.',
                }),
              },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'sub-search-1', name: 'search_code', arguments: '{"query":"alpha"}' },
            ],
          }),
        },
        { session: 'subagent', turn: scriptedTurn({ content: 'Child one summary.' }) },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-spawn-2',
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  description: 'Run child two',
                  prompt: 'Inspect beta path.',
                }),
              },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'sub-read-1', name: 'read_file', arguments: '{"path":"src/app.ts"}' },
            ],
          }),
        },
        { session: 'subagent', turn: scriptedTurn({ content: 'Child two summary.' }) },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({
                  summaryMarkdown: 'Two children completed.',
                  findings: [],
                }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'Main completed multi-child flow.' }) },
      ],
    });

    const submissionRecord = { submissions: [] as unknown[] };
    const { readFileTool, searchCodeTool, submitReviewFindingsTool } = makeTools(submissionRecord);
    const subagentRunner = new SubagentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [searchCodeTool, readFileTool],
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({ builtIn: [baseAgentDefinition()] }),
      executor: subagentRunner,
      defaultSubagentModel: 'subagent-model',
    });
    const runner = new MainAgentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [readFileTool, spawnSubagentTool, submitReviewFindingsTool],
    });

    const result = await runner.run({
      model: 'main-model',
      agentType: 'review-main-agent',
      userMessage: 'Run two delegated checks.',
      maxTurns: 10,
      maxToolCalls: 10,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(scriptedModel.toolCallSequence('main')).toEqual([
      'spawn_subagent',
      'spawn_subagent',
      'submit_review_findings',
    ]);
    expect(scriptedModel.toolCallSequence('subagent')).toEqual(['search_code', 'read_file']);

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.invocations).toHaveLength(2);
    expect(tree?.invocations[0].status).toBe('completed');
    expect(tree?.invocations[1].status).toBe('completed');
    expect(tree?.invocations[0].childSessionId).not.toBe(tree?.invocations[1].childSessionId);
    expect(
      tree?.invocations[0].childSession?.toolCalls.map((toolCall) => toolCall.toolName)
    ).toEqual(['search_code']);
    expect(
      tree?.invocations[1].childSession?.toolCalls.map((toolCall) => toolCall.toolName)
    ).toEqual(['read_file']);
    expect(submissionRecord.submissions).toEqual([
      { summaryMarkdown: 'Two children completed.', findings: [] },
    ]);
    scriptedModel.assertExhausted();
  });

  test('propagates structured subagent failure and still allows main completion', async () => {
    const scriptedModel = new ScriptedMockLLM({
      resolveSession: (request) => (request.model === 'subagent-model' ? 'subagent' : 'main'),
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-spawn-1',
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  description: 'Investigate quickly',
                  prompt: 'Run child checks.',
                }),
              },
            ],
          }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({
                  summaryMarkdown: 'Subagent failed; no findings.',
                  findings: [],
                }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'Main handled child failure.' }) },
      ],
    });

    const submissionRecord = { submissions: [] as unknown[] };
    const { submitReviewFindingsTool } = makeTools(submissionRecord);
    const subagentRunner = new SubagentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [],
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({ builtIn: [baseAgentDefinition()] }),
      executor: subagentRunner,
      defaultSubagentModel: 'subagent-model',
    });
    const runner = new MainAgentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [spawnSubagentTool, submitReviewFindingsTool],
    });

    const result = await runner.run({
      model: 'main-model',
      userMessage: 'Run subagent and continue on failure.',
      maxTurns: 6,
      maxToolCalls: 6,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(scriptedModel.toolCallSequence('main')).toEqual([
      'spawn_subagent',
      'submit_review_findings',
    ]);
    const secondMainRequest = scriptedModel.calls.filter((call) => call.session === 'main')[1];
    const lastMessage = secondMainRequest.request.messages.at(-1);
    expect(lastMessage?.role).toBe('tool');
    expect(lastMessage?.content).toContain('No scripted mock turn queued for session');

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.invocations).toHaveLength(1);
    expect(tree?.invocations[0].status).toBe('failed');
    expect(tree?.invocations[0].result).toMatchObject({
      status: 'failed',
      error: {
        code: 'Error',
        message: "No scripted mock turn queued for session 'subagent'",
      },
    });
    expect(submissionRecord.submissions).toEqual([
      { summaryMarkdown: 'Subagent failed; no findings.', findings: [] },
    ]);
    scriptedModel.assertExhausted();
  });

  test('filters disallowed child tools and persists deterministic failed tool call path', async () => {
    const scriptedModel = new ScriptedMockLLM({
      resolveSession: (request) => (request.model === 'subagent-model' ? 'subagent' : 'main'),
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-spawn-1',
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  description: 'Restricted run',
                  prompt: 'Try forbidden search first.',
                }),
              },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({
            toolCalls: [
              { id: 'sub-denied-1', name: 'search_code', arguments: '{"query":"restricted"}' },
            ],
          }),
        },
        {
          session: 'subagent',
          turn: scriptedTurn({ content: 'Child observed denied tool and completed.' }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'main-submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({
                  summaryMarkdown: 'Permission filtered as expected.',
                  findings: [],
                }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'Main completed restricted flow.' }) },
      ],
    });

    const submissionRecord = { submissions: [] as unknown[] };
    const { readFileTool, searchCodeTool, submitReviewFindingsTool } = makeTools(submissionRecord);
    const subagentRunner = new SubagentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [searchCodeTool, readFileTool],
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({
        builtIn: [
          {
            ...baseAgentDefinition(),
            tools: ['search_code', 'read_file'],
            disallowedTools: ['search_code'],
          },
        ],
      }),
      executor: subagentRunner,
      defaultSubagentModel: 'subagent-model',
    });
    const runner = new MainAgentRunner({
      modelClient: scriptedModel,
      transcriptRepository: agentSessionRepository,
      tools: [spawnSubagentTool, submitReviewFindingsTool],
    });

    const result = await runner.run({
      model: 'main-model',
      userMessage: 'Run with restricted subagent tools.',
      maxTurns: 8,
      maxToolCalls: 8,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(scriptedModel.toolCallSequence('main')).toEqual([
      'spawn_subagent',
      'submit_review_findings',
    ]);
    const secondSubagentRequest = scriptedModel.calls.filter(
      (call) => call.session === 'subagent'
    )[1];
    expect(secondSubagentRequest.request.messages.at(-1)?.role).toBe('tool');
    expect(secondSubagentRequest.request.messages.at(-1)?.content).toContain('ToolNotFoundError');

    const tree = agentSessionRepository.getSessionTree(result.sessionId);
    expect(tree?.invocations).toHaveLength(1);
    expect(tree?.invocations[0].childSession?.metadata).toMatchObject({
      toolPermissions: {
        allowedToolNames: ['search_code', 'read_file'],
        disallowedToolNames: ['search_code'],
        deniedToolNames: ['search_code'],
      },
    });
    expect(tree?.invocations[0].childSession?.toolCalls[0]).toMatchObject({
      toolName: 'search_code',
      status: 'failed',
      arguments: { query: 'restricted' },
      error: {
        name: 'ToolNotFoundError',
        message: "Tool 'search_code' is not registered",
      },
    });
    expect(submissionRecord.submissions).toEqual([
      { summaryMarkdown: 'Permission filtered as expected.', findings: [] },
    ]);
    scriptedModel.assertExhausted();
  });
});
