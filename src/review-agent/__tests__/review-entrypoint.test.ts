import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSessionRepository } from '../../agent-kernel/session';
import { closeDatabase, getDatabase, initDatabase } from '../../db/database';
import { ScriptedMockLLM, scriptedTurn } from '../../llm/e2e-mock';
import { RuntimeE2EMockLLM } from '../../llm/runtime-e2e-mock';
import type { LLMChatRequest, LLMChatResponse } from '../../llm/types';
import { FileReviewStore } from '../../review/store/file-review-store';
import type { ReviewContext, ReviewRun } from '../../review/types';
import { ReviewAgentEntrypoint } from '../review-entrypoint';

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

class FakeModelClient {
  requests: LLMChatRequest[] = [];

  constructor(private readonly responses: LLMChatResponse[]) {}

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (!next) throw new Error('No fake model response queued');
    return next;
  }
}

function makeRun(id: string): ReviewRun {
  return {
    id,
    idempotencyKey: 'octo/demo#7:base...head',
    eventType: 'pull_request',
    status: 'in_progress',
    owner: 'octo',
    repo: 'demo',
    cloneUrl: 'https://example.test/octo/demo.git',
    prNumber: 7,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    commitSha: 'head-sha',
    attempts: 0,
    maxAttempts: 2,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function makeReviewContext(workDir: string): ReviewContext {
  return {
    workspacePath: join(workDir, 'workspace'),
    mirrorPath: join(workDir, 'mirror.git'),
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+throw new Error("boom")',
    changedFiles: [{ path: 'src/app.ts', status: 'M', additions: 1, deletions: 0 }],
    parsedDiff: [
      {
        path: 'src/app.ts',
        changes: [{ lineNumber: 12, content: '+throw new Error("boom")', type: 'add' }],
      },
    ],
    fileContents: { 'src/app.ts': 'throw new Error("boom")' },
  };
}

function makeRuntimeE2EContext(workDir: string): ReviewContext {
  return {
    workspacePath: join(workDir, 'workspace-runtime-e2e'),
    mirrorPath: join(workDir, 'mirror-runtime-e2e.git'),
    diff: 'diff --git a/src/user-handler.ts b/src/user-handler.ts\n+const config = eval(input.config);',
    changedFiles: [{ path: 'src/user-handler.ts', status: 'M', additions: 1, deletions: 0 }],
    parsedDiff: [
      {
        path: 'src/user-handler.ts',
        changes: [{ lineNumber: 107, content: '+const config = eval(input.config);', type: 'add' }],
      },
    ],
    fileContents: {
      'src/user-handler.ts': [
        'export function handleUserRequest(input: any) {',
        '  const userId = input.userId;',
        "  const query = `SELECT * FROM users WHERE id = '${userId}'`;",
        '  const config = eval(input.config);',
        '  return { query, config };',
        '}',
      ].join('\n'),
    },
  };
}

describe('ReviewAgentEntrypoint', () => {
  let dbPath: string;
  let workDir: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    workDir = join(tmpdir(), `review-agent-entrypoint-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    dbPath = join(workDir, 'test.db');
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
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test('starts exactly one main agent session and stores submitted findings', async () => {
    const run = makeRun(randomUUID());
    const store = new FileReviewStore(workDir);
    await store.init();
    const persisted = await store.createOrReuseRun({
      eventType: 'pull_request',
      idempotencyKey: run.idempotencyKey,
      owner: run.owner,
      repo: run.repo,
      cloneUrl: run.cloneUrl,
      prNumber: run.prNumber!,
      baseSha: run.baseSha!,
      headSha: run.headSha!,
    });
    const reviewRun = persisted.run;
    const context = makeReviewContext(workDir);
    let prepared = 0;
    let cleaned = 0;
    let savedMirrorPath: string | undefined;
    let savedPrNumber: number | undefined;
    let savedBaseSha: string | undefined;
    let savedHeadSha: string | undefined;
    const localRepoManager = {
      prepareWorkspace: async () => {
        prepared += 1;
        return { mirrorPath: context.mirrorPath, workspacePath: context.workspacePath };
      },
      cleanupWorkspace: async () => {
        cleaned += 1;
      },
      resolveReviewedRef: async () => null,
      saveReviewedRef: async (
        mirrorPath: string,
        prNumber: number,
        baseSha: string,
        headSha: string
      ) => {
        savedMirrorPath = mirrorPath;
        savedPrNumber = prNumber;
        savedBaseSha = baseSha;
        savedHeadSha = headSha;
      },
    };
    const diffExtractor = {
      buildContext: async () => context,
    };
    const scriptedModel = new ScriptedMockLLM({
      steps: [
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'read-1',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'src/app.ts' }),
              },
            ],
          }),
        },
        {
          session: 'main',
          turn: scriptedTurn({
            toolCalls: [
              {
                id: 'submit-1',
                name: 'submit_review_findings',
                arguments: JSON.stringify({
                  summaryMarkdown: 'Found one issue.',
                  findings: [
                    {
                      fingerprint: 'fp-main-1',
                      category: 'correctness',
                      severity: 'high',
                      confidence: 0.91,
                      path: 'src/app.ts',
                      line: 12,
                      title: 'Unhandled throw',
                      detail: 'The changed line throws during normal execution.',
                      evidence: '+throw new Error("boom")',
                      suggestion: 'Return an error value instead.',
                    },
                  ],
                }),
              },
            ],
          }),
        },
        { session: 'main', turn: scriptedTurn({ content: 'submitted' }) },
      ],
    });

    const entrypoint = new ReviewAgentEntrypoint({
      store,
      localRepoManager: localRepoManager as never,
      diffExtractor: diffExtractor as never,
      modelClient: scriptedModel,
      model: 'fake-main-model',
    });

    const result = await entrypoint.execute(reviewRun);

    expect(result.status).toBe('submitted');
    expect(result.findings).toHaveLength(1);
    expect(result.summaryMarkdown).toBe('Found one issue.');
    expect(prepared).toBe(1);
    expect(cleaned).toBe(1);
    expect(scriptedModel.calls).toHaveLength(3);
    expect(scriptedModel.calls[0].request.tools?.map((tool) => tool.name)).toEqual([
      'list_changed_files',
      'get_diff',
      'get_file_patch',
      'read_file',
      'search_code',
      'find_references',
      'submit_review_findings',
      'spawn_subagent',
    ]);
    expect(scriptedModel.toolCallSequence('main')).toEqual(['read_file', 'submit_review_findings']);
    scriptedModel.assertExhausted();

    const session = agentSessionRepository.getSessionTree(result.sessionId);
    expect(session?.agentType).toBe('review-main-agent');
    expect(session?.metadata).toMatchObject({
      reviewRunId: reviewRun.id,
      sessionScope: 'pr:octo/demo#7',
      owner: 'octo',
      repo: 'demo',
      prNumber: 7,
      eventType: 'pull_request',
    });
    expect(session?.toolCalls).toHaveLength(2);
    expect(session?.toolCalls.map((tc) => tc.toolName)).toEqual([
      'read_file',
      'submit_review_findings',
    ]);
    expect(session?.invocations).toHaveLength(0);

    const sessionCount = getDatabase()
      .query('SELECT COUNT(*) AS count FROM agent_sessions')
      .get() as { count: number };
    expect(sessionCount.count).toBe(1);
    const details = await store.getRunDetails(reviewRun.id);
    expect(details?.findings).toHaveLength(1);
    expect(details?.findings[0]).toMatchObject({
      runId: reviewRun.id,
      fingerprint: 'fp-main-1',
      published: false,
    });
    expect(details?.comments).toHaveLength(2);
    expect(details?.comments[0]).toMatchObject({
      runId: reviewRun.id,
      body: '## AI Agent代码审查结果\n\nFound one issue.\n\n发现 1 个问题（high 1 / medium 0 / low 0）',
      status: 'pending',
    });
    expect(details?.comments[1]).toMatchObject({
      runId: reviewRun.id,
      path: 'src/app.ts',
      line: 12,
      fingerprint: 'fp-main-1',
      status: 'pending',
    });
    expect(savedMirrorPath).toBe(context.mirrorPath);
    expect(savedPrNumber).toBe(7);
    expect(savedBaseSha).toBe('base-sha');
    expect(savedHeadSha).toBe('head-sha');
  });

  test('runtime e2e mock advances through main/subagent flow and persists outputs', async () => {
    const run = makeRun(randomUUID());
    const store = new FileReviewStore(workDir);
    await store.init();
    const persisted = await store.createOrReuseRun({
      eventType: 'pull_request',
      idempotencyKey: run.idempotencyKey,
      owner: run.owner,
      repo: run.repo,
      cloneUrl: run.cloneUrl,
      prNumber: run.prNumber!,
      baseSha: run.baseSha!,
      headSha: run.headSha!,
    });
    const reviewRun = persisted.run;
    const context = makeRuntimeE2EContext(workDir);

    const localRepoManager = {
      prepareWorkspace: async () => ({
        mirrorPath: context.mirrorPath,
        workspacePath: context.workspacePath,
      }),
      cleanupWorkspace: async () => {},
      resolveReviewedRef: async () => null,
      saveReviewedRef: async () => {},
    };
    const diffExtractor = {
      buildContext: async () => context,
    };

    const entrypoint = new ReviewAgentEntrypoint({
      store,
      localRepoManager: localRepoManager as never,
      diffExtractor: diffExtractor as never,
      modelClient: new RuntimeE2EMockLLM(),
      model: 'runtime-e2e-main-model',
    });

    const result = await entrypoint.execute(reviewRun);

    expect(result.status).toBe('submitted');
    const session = agentSessionRepository.getSessionTree(result.sessionId);
    expect(session?.agentType).toBe('review-main-agent');
    expect(session?.toolCalls.map((tc) => tc.toolName)).toEqual([
      'read_file',
      'spawn_subagent',
      'submit_review_findings',
    ]);
    expect(session?.invocations).toHaveLength(1);
    expect(session?.invocations[0].status).toBe('completed');
    expect(session?.invocations[0].childSession?.toolCalls.map((tc) => tc.toolName)).toEqual([
      'search_code',
      'read_file',
    ]);

    const details = await store.getRunDetails(reviewRun.id);
    expect(details?.findings.length).toBeGreaterThan(0);
    expect(details?.comments.length).toBeGreaterThan(0);
    expect(details?.findings[0]).toMatchObject({
      path: 'src/user-handler.ts',
      severity: 'high',
      published: false,
    });
  });

  test('dedupes similar findings and keeps comment intents idempotent across retries', async () => {
    const run = makeRun(randomUUID());
    const store = new FileReviewStore(workDir);
    await store.init();
    const persisted = await store.createOrReuseRun({
      eventType: 'pull_request',
      idempotencyKey: run.idempotencyKey,
      owner: run.owner,
      repo: run.repo,
      cloneUrl: run.cloneUrl,
      prNumber: run.prNumber!,
      baseSha: run.baseSha!,
      headSha: run.headSha!,
    });
    const reviewRun = persisted.run;
    const context = makeReviewContext(workDir);

    const submissionArgs = {
      summaryMarkdown: 'Potential runtime risks found.',
      findings: [
        {
          fingerprint: 'fp-dup-1',
          category: 'reliability',
          severity: 'high',
          confidence: 0.9,
          path: 'src/app.ts',
          line: 12,
          title: 'Unhandled throw in request path',
          detail: 'Throw escapes normal request handling.',
          evidence: '+throw new Error("boom")',
          suggestion: 'Return typed failure.',
        },
        {
          fingerprint: 'fp-dup-2',
          category: 'reliability',
          severity: 'medium',
          confidence: 0.8,
          path: 'src/app.ts',
          line: 12,
          title: 'Unhandled throw in request path',
          detail: 'Same root cause with lower severity.',
          evidence: '+throw new Error("boom")',
          suggestion: 'Use result object.',
        },
      ],
    };

    const fakeModel = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submit-1',
            name: 'submit_review_findings',
            arguments: JSON.stringify(submissionArgs),
          },
        ],
      }),
      response({ content: 'submitted-1' }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submit-2',
            name: 'submit_review_findings',
            arguments: JSON.stringify(submissionArgs),
          },
        ],
      }),
      response({ content: 'submitted-2' }),
    ]);

    const localRepoManager = {
      prepareWorkspace: async () => ({
        mirrorPath: context.mirrorPath,
        workspacePath: context.workspacePath,
      }),
      cleanupWorkspace: async () => undefined,
      resolveReviewedRef: async () => null,
      saveReviewedRef: async () => undefined,
    };
    const diffExtractor = { buildContext: async () => context };

    const entrypoint = new ReviewAgentEntrypoint({
      store,
      localRepoManager: localRepoManager as never,
      diffExtractor: diffExtractor as never,
      modelClient: fakeModel,
      model: 'fake-main-model',
    });

    await entrypoint.execute(reviewRun);
    await entrypoint.execute(reviewRun);

    const details = await store.getRunDetails(reviewRun.id);
    expect(details?.findings).toHaveLength(1);
    expect(details?.findings[0]).toMatchObject({
      path: 'src/app.ts',
      line: 12,
      title: 'Unhandled throw in request path',
      severity: 'high',
    });
    expect(details?.comments).toHaveLength(2);
    expect(details?.comments.filter((comment) => !comment.path)).toHaveLength(1);
    expect(details?.comments.filter((comment) => comment.path)).toHaveLength(1);
  });

  test('publishes line-intents for high/medium only and keeps low severity in summary', async () => {
    const run = makeRun(randomUUID());
    const store = new FileReviewStore(workDir);
    await store.init();
    const persisted = await store.createOrReuseRun({
      eventType: 'pull_request',
      idempotencyKey: run.idempotencyKey,
      owner: run.owner,
      repo: run.repo,
      cloneUrl: run.cloneUrl,
      prNumber: run.prNumber!,
      baseSha: run.baseSha!,
      headSha: run.headSha!,
    });
    const reviewRun = persisted.run;
    const context = makeReviewContext(workDir);

    const fakeModel = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submit-severity',
            name: 'submit_review_findings',
            arguments: JSON.stringify({
              summaryMarkdown: 'Three candidates reported.',
              findings: [
                {
                  fingerprint: 'fp-high',
                  category: 'correctness',
                  severity: 'high',
                  confidence: 0.95,
                  path: 'src/app.ts',
                  line: 12,
                  title: 'High issue',
                  detail: 'High severity detail',
                  evidence: 'e1',
                  suggestion: 's1',
                },
                {
                  fingerprint: 'fp-medium',
                  category: 'reliability',
                  severity: 'medium',
                  confidence: 0.88,
                  path: 'src/app.ts',
                  line: 13,
                  title: 'Medium issue',
                  detail: 'Medium severity detail',
                  evidence: 'e2',
                  suggestion: 's2',
                },
                {
                  fingerprint: 'fp-low',
                  category: 'maintainability',
                  severity: 'low',
                  confidence: 0.8,
                  path: 'src/app.ts',
                  line: 14,
                  title: 'Low issue',
                  detail: 'Low severity detail',
                  evidence: 'e3',
                  suggestion: 's3',
                },
              ],
            }),
          },
        ],
      }),
      response({ content: 'submitted' }),
    ]);

    const localRepoManager = {
      prepareWorkspace: async () => ({
        mirrorPath: context.mirrorPath,
        workspacePath: context.workspacePath,
      }),
      cleanupWorkspace: async () => undefined,
      resolveReviewedRef: async () => null,
      saveReviewedRef: async () => undefined,
    };
    const diffExtractor = { buildContext: async () => context };

    const entrypoint = new ReviewAgentEntrypoint({
      store,
      localRepoManager: localRepoManager as never,
      diffExtractor: diffExtractor as never,
      modelClient: fakeModel,
      model: 'fake-main-model',
    });

    await entrypoint.execute(reviewRun);

    const details = await store.getRunDetails(reviewRun.id);
    expect(details?.findings).toHaveLength(3);
    const summaryRecords = details?.comments.filter((comment) => !comment.path) ?? [];
    const lineRecords = details?.comments.filter((comment) => !!comment.path) ?? [];
    expect(summaryRecords).toHaveLength(1);
    expect(lineRecords).toHaveLength(2);
    expect(lineRecords.map((record) => record.fingerprint).sort()).toEqual([
      'fp-high',
      'fp-medium',
    ]);
    expect(lineRecords.some((record) => record.fingerprint === 'fp-low')).toBe(false);
    expect(summaryRecords[0].body).toContain('high 1 / medium 1 / low 1');
  });

  test('retry does not duplicate pending summary or existing line comment records', async () => {
    const run = makeRun(randomUUID());
    const store = new FileReviewStore(workDir);
    await store.init();
    const persisted = await store.createOrReuseRun({
      eventType: 'pull_request',
      idempotencyKey: run.idempotencyKey,
      owner: run.owner,
      repo: run.repo,
      cloneUrl: run.cloneUrl,
      prNumber: run.prNumber!,
      baseSha: run.baseSha!,
      headSha: run.headSha!,
    });
    const reviewRun = persisted.run;
    const context = makeReviewContext(workDir);

    const summaryBody =
      '## AI Agent代码审查结果\n\nSeeded summary body\n\n发现 2 个问题（high 1 / medium 1 / low 0）';
    const lineBodyHigh =
      '**[HIGH][correctness]** Seeded high issue\n\nHigh detail\n\n建议: High suggestion';

    await store.addCommentRecord({ runId: reviewRun.id, body: summaryBody, status: 'pending' });
    await store.addCommentRecord({
      runId: reviewRun.id,
      path: 'src/app.ts',
      line: 12,
      body: lineBodyHigh,
      status: 'published',
      fingerprint: 'fp-seeded-high',
    });

    const fakeModel = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submit-retry-1',
            name: 'submit_review_findings',
            arguments: JSON.stringify({
              summaryMarkdown: 'Seeded summary body',
              findings: [
                {
                  fingerprint: 'fp-seeded-high',
                  category: 'correctness',
                  severity: 'high',
                  confidence: 0.95,
                  path: 'src/app.ts',
                  line: 12,
                  title: 'Seeded high issue',
                  detail: 'High detail',
                  evidence: 'e1',
                  suggestion: 'High suggestion',
                },
                {
                  fingerprint: 'fp-new-medium',
                  category: 'reliability',
                  severity: 'medium',
                  confidence: 0.83,
                  path: 'src/app.ts',
                  line: 20,
                  title: 'New medium issue',
                  detail: 'Medium detail',
                  evidence: 'e2',
                  suggestion: 'Medium suggestion',
                },
              ],
            }),
          },
        ],
      }),
      response({ content: 'submitted-1' }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submit-retry-2',
            name: 'submit_review_findings',
            arguments: JSON.stringify({
              summaryMarkdown: 'Seeded summary body',
              findings: [
                {
                  fingerprint: 'fp-seeded-high',
                  category: 'correctness',
                  severity: 'high',
                  confidence: 0.95,
                  path: 'src/app.ts',
                  line: 12,
                  title: 'Seeded high issue',
                  detail: 'High detail',
                  evidence: 'e1',
                  suggestion: 'High suggestion',
                },
                {
                  fingerprint: 'fp-new-medium',
                  category: 'reliability',
                  severity: 'medium',
                  confidence: 0.83,
                  path: 'src/app.ts',
                  line: 20,
                  title: 'New medium issue',
                  detail: 'Medium detail',
                  evidence: 'e2',
                  suggestion: 'Medium suggestion',
                },
              ],
            }),
          },
        ],
      }),
      response({ content: 'submitted-2' }),
    ]);

    const localRepoManager = {
      prepareWorkspace: async () => ({
        mirrorPath: context.mirrorPath,
        workspacePath: context.workspacePath,
      }),
      cleanupWorkspace: async () => undefined,
      resolveReviewedRef: async () => null,
      saveReviewedRef: async () => undefined,
    };
    const diffExtractor = { buildContext: async () => context };

    const entrypoint = new ReviewAgentEntrypoint({
      store,
      localRepoManager: localRepoManager as never,
      diffExtractor: diffExtractor as never,
      modelClient: fakeModel,
      model: 'fake-main-model',
    });

    await entrypoint.execute(reviewRun);
    await entrypoint.execute(reviewRun);

    const details = await store.getRunDetails(reviewRun.id);
    const summaryRecords = details?.comments.filter((comment) => !comment.path) ?? [];
    const lineRecords = details?.comments.filter((comment) => !!comment.path) ?? [];
    expect(summaryRecords).toHaveLength(1);
    expect(lineRecords).toHaveLength(2);
    expect(lineRecords.filter((comment) => comment.fingerprint === 'fp-seeded-high')).toHaveLength(
      1
    );
    expect(lineRecords.filter((comment) => comment.fingerprint === 'fp-new-medium')).toHaveLength(
      1
    );
  });
});
