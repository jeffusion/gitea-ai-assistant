import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { kernelSessionRepository } from '../../../agent-kernel/session/session-repository';
import { closeDatabase, getDatabase, initDatabase } from '../../../db/database';
import { llmGateway } from '../../../llm/gateway';
import type { LLMChatRequest, LLMChatResponse, ModelRole } from '../../../llm/types';
import { giteaService } from '../../../services/gitea';
import { FileReviewStore } from '../../store/file-review-store';
import type { PullRequestReviewPayload, ReviewContext, ReviewRun } from '../../types';
import { ReviewKernelRuntime } from '../review-kernel-runtime';
import { REVIEW_FULL_REVIEW_SUBAGENT, REVIEW_TRIAGE_SUBAGENT } from '../review-subagent-ids';
import { getReviewSessionScope } from '../session-scope';

function createPullRequestPayload(
  keySuffix: string,
  overrides: Partial<PullRequestReviewPayload> = {}
): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:101:${keySuffix}`,
    eventType: 'pull_request' as const,
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 101,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    maxAttempts: 2,
    ...overrides,
  };
}

function createHappyPathContext(workspacePath: string, mirrorPath: string): ReviewContext {
  return {
    workspacePath,
    mirrorPath,
    diff: [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,2 +1,3 @@',
      ' export function checkFlag(input?: string) {',
      '+  return input.trim() === "on";',
      ' }',
    ].join('\n'),
    changedFiles: [{ path: 'src/index.ts', status: 'M', additions: 1, deletions: 1 }],
    parsedDiff: [
      {
        path: 'src/index.ts',
        changes: [
          {
            lineNumber: 1,
            oldLineNumber: 1,
            content: 'export function checkFlag(input?: string) {',
            type: 'context',
          },
          { lineNumber: 2, content: '  return input.trim() === "on";', type: 'add' },
          { lineNumber: 3, oldLineNumber: 2, content: '}', type: 'context' },
        ],
      },
    ],
    fileContents: {
      'src/index.ts':
        'export function checkFlag(input?: string) {\n  return input.trim() === "on";\n}',
    },
  };
}

function createJsonResponse(content: Record<string, unknown>): LLMChatResponse {
  return {
    content: JSON.stringify(content),
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

describe('ReviewKernelRuntime happy path', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;
  let store: FileReviewStore;
  let chatCalls: Array<{ role: ModelRole; request: Omit<LLMChatRequest, 'model'> }>;
  let summaryBodies: string[];
  let lineCommentCalls: Array<{
    owner: string;
    repo: string;
    prNumber: number;
    commitId: string;
    comments: Array<{ path: string; line: number; comment: string }>;
  }>;
  let savedReviewedRefs: Array<{
    mirrorPath: string;
    prNumber: number;
    baseSha: string;
    targetSha: string;
  }>;
  let cleanedWorkspaces: Array<{ mirrorPath: string; workspacePath: string }>;
  let prepareWorkspaceCalls: string[];

  const originalChatForRole = llmGateway.chatForRole;
  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;
  const originalAddLineComments = giteaService.addLineComments;
  const originalGetRelatedPullRequest = giteaService.getRelatedPullRequest;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-happy-path-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
    initDatabase();

    store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
    await store.init();

    chatCalls = [];
    summaryBodies = [];
    lineCommentCalls = [];
    savedReviewedRefs = [];
    cleanedWorkspaces = [];
    prepareWorkspaceCalls = [];

    llmGateway.chatForRole = async (role, request) => {
      chatCalls.push({ role, request });

      if (role !== 'specialist') {
        throw new Error(`Unexpected LLM role: ${role}`);
      }

      return createJsonResponse({
        findings: [
          {
            severity: 'high',
            confidence: 0.98,
            path: 'src/index.ts',
            line: 2,
            title: 'Missing optional chaining before trim',
            detail: 'input 是可选参数，直接调用 trim 会在 undefined 时抛出异常。',
            evidence: 'return input.trim() === "on";',
            suggestion: '改为 input?.trim() === "on" 或先做空值判断。',
          },
        ],
      });
    };

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      summaryBodies.push(body);
    };
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in pull request happy path');
    };
    giteaService.addLineComments = async (owner, repo, prNumber, commitId, comments) => {
      lineCommentCalls.push({ owner, repo, prNumber, commitId, comments });
    };
    giteaService.getRelatedPullRequest = async () => ({ number: 101 }) as any;
  });

  afterEach(async () => {
    llmGateway.chatForRole = originalChatForRole;
    giteaService.addPullRequestComment = originalAddPullRequestComment;
    giteaService.addCommitComment = originalAddCommitComment;
    giteaService.addLineComments = originalAddLineComments;
    giteaService.getRelatedPullRequest = originalGetRelatedPullRequest;

    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('execute drives full runtime happy path with persisted artifacts', async () => {
    const { run } = await store.createOrReuseRun(createPullRequestPayload('happy-path'));
    const { scopeType, scopeKey } = getReviewSessionScope(run);
    const session = kernelSessionRepository.ensureSession({
      scopeType,
      scopeKey,
      metadata: {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
        eventType: run.eventType,
        headSha: run.headSha,
      },
      runId: run.id,
    });

    const runtime = new ReviewKernelRuntime(
      store,
      {
        prepareWorkspace: async (_owner, _repo, _cloneUrl, targetSha, runId) => {
          prepareWorkspaceCalls.push(`${runId}:${targetSha}`);
          return {
            mirrorPath: path.join(tempDir, 'repos', 'mirror.git'),
            workspacePath: path.join(tempDir, 'workspaces', runId),
          };
        },
        resolveReviewedRef: async () => null,
        saveReviewedRef: async (mirrorPath, prNumber, baseSha, targetSha) => {
          savedReviewedRefs.push({ mirrorPath, prNumber, baseSha, targetSha });
        },
        cleanupWorkspace: async ({ mirrorPath, workspacePath }) => {
          cleanedWorkspaces.push({ mirrorPath, workspacePath });
        },
      } as any,
      {
        getSandbox: () => ({
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        buildContext: async (_runtimeRun: ReviewRun, mirrorPath: string, workspacePath: string) =>
          createHappyPathContext(workspacePath, mirrorPath),
      } as any
    );

    const checkpoint = await runtime.execute(run, session.id);
    const persistedCheckpoint = kernelSessionRepository.loadCheckpoint(session.id);
    const events = kernelSessionRepository.listEvents(session.id);
    const invocations = kernelSessionRepository.listSubagentInvocations(session.id);
    const runDetails = await store.getRunDetails(run.id);

    expect(checkpoint.stopReason).toBe('completed');
    expect(checkpoint.pendingTasks).toEqual([]);
    expect(checkpoint.state.published).toBe(true);
    expect(checkpoint.state.reviewedRefSaved).toBe(true);
    expect(checkpoint.state.reviewCompleted).toBe(true);
    expect(checkpoint.state.reviewHints).toHaveLength(1);
    expect(checkpoint.state.reviewTask).toMatchObject({
      mode: 'light',
      suspectedEntrypoints: ['src/index.ts'],
      tokenBudget: expect.any(Number),
    });
    expect(checkpoint.state.findings).toHaveLength(1);
    expect(checkpoint.state.findings[0]).toMatchObject({
      category: 'correctness',
      severity: 'high',
      confidence: 0.98,
      path: 'src/index.ts',
      line: 2,
      title: 'Missing optional chaining before trim',
    });
    expect(persistedCheckpoint?.stopReason).toBe('completed');
    expect(persistedCheckpoint?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
      reviewCompleted: true,
    });

    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'run_started',
        'hook_session_start',
        'task_started',
        'task_completed',
        'run_completed',
      ])
    );
    expect(eventTypes.filter((type) => type === 'run_started')).toHaveLength(1);
    expect(eventTypes.filter((type) => type === 'hook_session_start')).toHaveLength(1);
    expect(eventTypes.filter((type) => type === 'run_completed')).toHaveLength(1);

    const majorTaskStarts = events
      .filter((event) => event.eventType === 'task_started')
      .map((event) => String(event.payload.name));
    const majorTaskCompletions = events
      .filter((event) => event.eventType === 'task_completed')
      .map((event) => String(event.payload.name));

    const expectedMajorTasks = [
      'prepare_workspace',
      'build_context',
      REVIEW_TRIAGE_SUBAGENT,
      REVIEW_FULL_REVIEW_SUBAGENT,
      'aggregate_findings',
      'publish_review',
      'save_reviewed_ref',
    ];
    expect(majorTaskStarts).toEqual(expect.arrayContaining(expectedMajorTasks));
    expect(majorTaskCompletions).toEqual(expect.arrayContaining(expectedMajorTasks));
    expect(majorTaskStarts).toHaveLength(expectedMajorTasks.length);
    expect(majorTaskCompletions).toHaveLength(expectedMajorTasks.length);

    const firstFourTasks = expectedMajorTasks.slice(0, 4);
    const orderedCriticalTaskEvents = getDatabase()
      .query(
        `SELECT event_type, payload_json
         FROM agent_kernel_session_events
         WHERE session_id = ?
         ORDER BY rowid ASC`
      )
      .all(session.id) as Array<{ event_type: string; payload_json: string }>;
    const normalizedCriticalTaskEvents = orderedCriticalTaskEvents
      .filter(
        (event) =>
          (event.event_type === 'task_started' || event.event_type === 'task_completed') &&
          firstFourTasks.includes(
            String((JSON.parse(event.payload_json) as { name?: string }).name)
          )
      )
      .map((event) => ({
        eventType: event.event_type,
        name: String((JSON.parse(event.payload_json) as { name?: string }).name),
      }));
    expect(normalizedCriticalTaskEvents).toEqual([
      { eventType: 'task_started', name: 'prepare_workspace' },
      { eventType: 'task_completed', name: 'prepare_workspace' },
      { eventType: 'task_started', name: 'build_context' },
      { eventType: 'task_completed', name: 'build_context' },
      { eventType: 'task_started', name: REVIEW_TRIAGE_SUBAGENT },
      { eventType: 'task_completed', name: REVIEW_TRIAGE_SUBAGENT },
      { eventType: 'task_started', name: REVIEW_FULL_REVIEW_SUBAGENT },
      { eventType: 'task_completed', name: REVIEW_FULL_REVIEW_SUBAGENT },
    ]);

    const completedInvocations = invocations.filter(
      (invocation) => invocation.status === 'completed'
    );
    expect(completedInvocations.length).toBeGreaterThanOrEqual(2);
    expect(completedInvocations.map((item) => item.subagentName)).toEqual(
      expect.arrayContaining([REVIEW_TRIAGE_SUBAGENT, REVIEW_FULL_REVIEW_SUBAGENT])
    );

    const fullReviewSteps = runDetails?.steps.filter(
      (step) => step.stepName === 'kernel_review_full'
    );
    expect(fullReviewSteps).toHaveLength(2);
    expect(fullReviewSteps?.filter((step) => step.status === 'started')).toHaveLength(1);
    expect(fullReviewSteps?.filter((step) => step.status === 'succeeded')).toHaveLength(1);

    expect(runDetails).not.toBeNull();
    expect(runDetails?.findings).toHaveLength(1);
    expect(runDetails?.findings[0]).toMatchObject({
      category: 'correctness',
      severity: 'high',
      confidence: 0.98,
      path: 'src/index.ts',
      line: 2,
      published: true,
    });
    expect(runDetails?.comments).toHaveLength(2);
    expect(runDetails?.comments.filter((comment) => comment.status === 'published')).toHaveLength(
      2
    );
    expect(runDetails?.comments.find((comment) => !comment.path)?.body).toContain(
      '## AI 代码审查结果'
    );
    expect(runDetails?.comments.find((comment) => comment.path === 'src/index.ts')).toMatchObject({
      line: 2,
      status: 'published',
    });

    expect(summaryBodies).toHaveLength(1);
    expect(summaryBodies[0]).toContain('发现 1 个需要关注的问题');
    expect(summaryBodies[0]).toContain('### 必须优先处理');
    expect(summaryBodies[0]).not.toContain('[HIGH]');
    expect(lineCommentCalls).toHaveLength(1);
    expect(lineCommentCalls[0]).toMatchObject({
      owner: 'acme',
      repo: 'repo',
      prNumber: 101,
      commitId: 'head-sha',
    });
    expect(lineCommentCalls[0].comments).toEqual([
      {
        path: 'src/index.ts',
        line: 2,
        comment: expect.stringContaining('Missing optional chaining before trim'),
      },
    ]);
    expect(lineCommentCalls[0].comments[0].comment).toContain('建议：');
    expect(lineCommentCalls[0].comments[0].comment).toContain(
      '_优先级：必须优先处理 · 类型：功能正确性_'
    );
    expect(lineCommentCalls[0].comments[0].comment).not.toContain('[HIGH]');
    expect(lineCommentCalls[0].comments[0].comment).not.toContain('[correctness]');

    expect(savedReviewedRefs).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'mirror.git'),
        prNumber: 101,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
    ]);
    expect(cleanedWorkspaces).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'mirror.git'),
        workspacePath: path.join(tempDir, 'workspaces', run.id),
      },
    ]);
    expect(prepareWorkspaceCalls).toEqual([`${run.id}:head-sha`]);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].role).toBe('specialist');
    expect(
      chatCalls[0].request.messages.some((message) => message.content.includes('审查任务'))
    ).toBe(true);
  });

  test('execute stops early when target sha is missing', async () => {
    const { run } = await store.createOrReuseRun(createPullRequestPayload('missing-target-sha'));
    const runWithoutTargetSha: ReviewRun = {
      ...run,
      headSha: undefined,
      commitSha: undefined,
    };
    const { scopeType, scopeKey } = getReviewSessionScope({
      ...run,
      commitSha: 'placeholder-commit-for-scope',
    });
    const session = kernelSessionRepository.ensureSession({
      scopeType,
      scopeKey,
      metadata: {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
        eventType: run.eventType,
      },
      runId: run.id,
    });

    const runtime = new ReviewKernelRuntime(
      store,
      {
        prepareWorkspace: async () => {
          throw new Error('prepareWorkspace should not run when target sha is missing');
        },
        resolveReviewedRef: async () => null,
        saveReviewedRef: async () => undefined,
        cleanupWorkspace: async () => undefined,
      } as any,
      {
        getSandbox: () => ({
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        buildContext: async () => {
          throw new Error('buildContext should not run when target sha is missing');
        },
      } as any
    );

    const checkpoint = await runtime.execute(runWithoutTargetSha, session.id);
    const persistedCheckpoint = kernelSessionRepository.loadCheckpoint(session.id);
    const events = kernelSessionRepository.listEvents(session.id);
    const runDetails = await store.getRunDetails(run.id);

    expect(checkpoint.stopReason).toBe('missing_target_sha');
    expect(checkpoint.pendingTasks).toEqual([]);
    expect(checkpoint.state).toMatchObject({
      findings: [],
      reviewCompleted: false,
      reviewHints: [],
      published: false,
      reviewedRefSaved: false,
    });
    expect(persistedCheckpoint).toBeNull();
    expect(events.filter((event) => event.eventType.startsWith('task_'))).toEqual([]);
    expect(events).toEqual([]);
    expect(runDetails?.run.status).toBe('ignored');
    expect(runDetails?.run.error).toBe('缺少目标 sha');
  });
});
