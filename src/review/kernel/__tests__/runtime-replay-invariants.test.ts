import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { kernelSessionRepository } from '../../../agent-kernel/session/session-repository';
import type { KernelSessionEventRecord } from '../../../agent-kernel/types';
import { closeDatabase, getDatabase, initDatabase } from '../../../db/database';
import { llmGateway } from '../../../llm/gateway';
import type { LLMChatRequest, LLMChatResponse, ModelRole } from '../../../llm/types';
import { giteaService } from '../../../services/gitea';
import { FileReviewStore } from '../../store/file-review-store';
import type { PullRequestReviewPayload, ReviewContext, ReviewRun } from '../../types';
import { ReviewKernelRuntime } from '../review-kernel-runtime';
import type { ReviewKernelState } from '../review-kernel-state';
import { REVIEW_FULL_REVIEW_SUBAGENT, REVIEW_TRIAGE_SUBAGENT } from '../review-subagent-ids';
import { getReviewSessionScope } from '../session-scope';

function createPullRequestPayload(keySuffix: string): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:401:${keySuffix}`,
    eventType: 'pull_request',
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 401,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    maxAttempts: 2,
  };
}

function createReplayContext(workspacePath: string, mirrorPath: string): ReviewContext {
  return {
    workspacePath,
    mirrorPath,
    diff: [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,2 +1,3 @@',
      ' export function checkFlag(input?: string) {',
      '+  return input.trim() === "on" ? input.length : 0;',
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
          {
            lineNumber: 2,
            content: '  return input.trim() === "on" ? input.length : 0;',
            type: 'add',
          },
          { lineNumber: 3, oldLineNumber: 2, content: '}', type: 'context' },
        ],
      },
    ],
    fileContents: {
      'src/index.ts':
        'export function checkFlag(input?: string) {\n  return input.trim() === "on" ? input.length : 0;\n}',
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

function getTaskNames(sessionId: string, eventType: 'task_started' | 'task_completed'): string[] {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) => event.eventType === eventType)
    .map((event) => String(event.payload.name));
}

function getEventTypes(sessionId: string): string[] {
  return kernelSessionRepository.listEvents(sessionId).map((event) => event.eventType);
}

function getRunCompletedEvents(sessionId: string): KernelSessionEventRecord[] {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) => event.eventType === 'run_completed');
}

describe('ReviewKernelRuntime replay invariants', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;
  let store: FileReviewStore;
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
  let chatCalls: Array<{ role: ModelRole; request: Omit<LLMChatRequest, 'model'> }>;

  const originalChatForRole = llmGateway.chatForRole;
  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;
  const originalAddLineComments = giteaService.addLineComments;
  const originalGetRelatedPullRequest = giteaService.getRelatedPullRequest;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-replay-invariants-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
    initDatabase();

    store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
    await store.init();

    summaryBodies = [];
    lineCommentCalls = [];
    savedReviewedRefs = [];
    cleanedWorkspaces = [];
    chatCalls = [];

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      summaryBodies.push(body);
    };
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in replay invariant tests');
    };
    giteaService.addLineComments = async (owner, repo, prNumber, commitId, comments) => {
      lineCommentCalls.push({ owner, repo, prNumber, commitId, comments });
    };
    giteaService.getRelatedPullRequest = async () => ({ number: 401 }) as any;
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

  function configureFindings(mode: 'gated' | 'publishable-only'): void {
    llmGateway.chatForRole = async (role, request) => {
      chatCalls.push({ role, request });

      if (role !== 'specialist') {
        throw new Error(`Unexpected LLM role: ${role}`);
      }

      if (mode === 'publishable-only') {
        return createJsonResponse({
          findings: [
            {
              fingerprint: 'publishable-finding',
              severity: 'high',
              confidence: 0.98,
              path: 'src/index.ts',
              line: 2,
              title: 'Missing optional chaining before trim',
              detail: 'input 是可选参数，直接调用 trim 会在 undefined 时抛出异常。',
              evidence: 'return input.trim() === "on" ? input.length : 0;',
              suggestion: '改为 input?.trim() === "on" ? input.length : 0。',
            },
          ],
        });
      }

      return createJsonResponse({
        findings: [
          {
            fingerprint: 'publishable-finding',
            severity: 'high',
            confidence: 0.98,
            path: 'src/index.ts',
            line: 2,
            title: 'Missing optional chaining before trim',
            detail: 'input 是可选参数，直接调用 trim 会在 undefined 时抛出异常。',
            evidence: 'return input.trim() === "on" ? input.length : 0;',
            suggestion: '改为 input?.trim() === "on" ? input.length : 0。',
          },
          {
            fingerprint: 'gated-finding',
            severity: 'low',
            confidence: 0.99,
            path: 'src/index.ts',
            line: 2,
            title: 'Consider guarding string length usage',
            detail: '低严重度建议会进入人工审批队列。',
            evidence: 'return input.trim() === "on" ? input.length : 0;',
            suggestion: '在读取 length 前统一做空值保护。',
          },
        ],
      });
    };
  }

  function createRuntime(): ReviewKernelRuntime {
    return new ReviewKernelRuntime(
      store,
      {
        prepareWorkspace: async (
          _owner: string,
          _repo: string,
          _cloneUrl: string,
          targetSha: string,
          runId: string
        ) => ({
          mirrorPath: path.join(tempDir, 'repos', `${targetSha}-mirror.git`),
          workspacePath: path.join(tempDir, 'workspaces', runId),
        }),
        resolveReviewedRef: async () => null,
        saveReviewedRef: async (
          mirrorPath: string,
          prNumber: number,
          baseSha: string,
          targetSha: string
        ) => {
          savedReviewedRefs.push({ mirrorPath, prNumber, baseSha, targetSha });
        },
        cleanupWorkspace: async ({
          mirrorPath,
          workspacePath,
        }: { mirrorPath: string; workspacePath: string }) => {
          cleanedWorkspaces.push({ mirrorPath, workspacePath });
        },
      } as any,
      {
        getSandbox: () => ({
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        buildContext: async (_run: ReviewRun, mirrorPath: string, workspacePath: string) =>
          createReplayContext(workspacePath, mirrorPath),
      } as any
    );
  }

  async function createRunSession(keySuffix: string) {
    const { run } = await store.createOrReuseRun(createPullRequestPayload(keySuffix));
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

    return { run, session };
  }

  test('rebuilds runtime from persisted checkpoint and continues with real checkpoint state', async () => {
    configureFindings('gated');
    const { run, session } = await createRunSession('rebuild-runtime');

    const firstRuntime = createRuntime();
    const firstCheckpoint = await firstRuntime.execute(run, session.id);
    const persistedBeforeResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );

    expect(firstCheckpoint.stopReason).toBe('completed');
    expect(persistedBeforeResume?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(persistedBeforeResume?.pendingTasks).toEqual([]);
    expect(persistedBeforeResume?.stopReason).toBe('completed');

    const resumedRuntime = createRuntime();
    const resumedCheckpoint = await resumedRuntime.continueExecution(run, session.id);
    const persistedAfterResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );
    const startedTasks = getTaskNames(session.id, 'task_started');
    const completedTasks = getTaskNames(session.id, 'task_completed');

    expect(resumedCheckpoint.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(resumedCheckpoint.pendingTasks).toEqual([]);
    expect(resumedCheckpoint.stopReason).toBe('completed');
    expect(persistedAfterResume?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(persistedAfterResume?.pendingTasks).toEqual([]);
    expect(persistedAfterResume?.stopReason).toBe('completed');
    expect(startedTasks.filter((name) => name === 'publish_review')).toHaveLength(1);
    expect(completedTasks.filter((name) => name === 'publish_review')).toHaveLength(1);
    expect(startedTasks.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(completedTasks.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(savedReviewedRefs).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        prNumber: 401,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
    ]);
    expect(getEventTypes(session.id)).toEqual(
      expect.arrayContaining(['run_started', 'run_completed', 'task_started', 'task_completed'])
    );
  });

  test('stale checkpoint wins over newer orphan events during continueExisting', async () => {
    configureFindings('gated');
    const { run, session } = await createRunSession('stale-checkpoint');

    const runtime = createRuntime();
    const firstCheckpoint = await runtime.execute(run, session.id);
    const staleState: ReviewKernelState = {
      ...firstCheckpoint.state,
      published: false,
      reviewedRefSaved: false,
    };

    kernelSessionRepository.saveCheckpoint(session.id, {
      state: staleState,
      pendingTasks: [],
      stopReason: 'awaiting_human_feedback',
    });
    kernelSessionRepository.appendEvent(session.id, 'task_completed', {
      kind: 'skill',
      name: 'save_reviewed_ref',
      runId: run.id,
      stopReason: 'completed',
    });
    kernelSessionRepository.appendEvent(session.id, 'run_completed', {
      runId: run.id,
      stopReason: 'completed',
      findings: 1,
    });

    const resumedCheckpoint = await createRuntime().continueExecution(run, session.id);
    const persistedAfterResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );
    const completedTasks = getTaskNames(session.id, 'task_completed');
    const runCompletedEvents = getRunCompletedEvents(session.id);

    expect(resumedCheckpoint.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(resumedCheckpoint.pendingTasks).toEqual([]);
    expect(resumedCheckpoint.stopReason).toBe('completed');
    expect(persistedAfterResume?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(persistedAfterResume?.pendingTasks).toEqual([]);
    expect(persistedAfterResume?.stopReason).toBe('completed');
    expect(completedTasks.filter((name) => name === 'save_reviewed_ref')).toHaveLength(3);
    expect(completedTasks.filter((name) => name === 'publish_review')).toHaveLength(2);
    expect(runCompletedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ stopReason: 'completed' }),
        }),
        expect.objectContaining({ payload: expect.objectContaining({ stopReason: 'completed' }) }),
      ])
    );
    expect(summaryBodies).toHaveLength(1);
    expect(lineCommentCalls).toHaveLength(1);
  });

  test('missing checkpoint with existing event history restarts from initial runtime state instead of replaying events', async () => {
    configureFindings('publishable-only');
    const { run, session } = await createRunSession('missing-checkpoint');

    kernelSessionRepository.appendEvent(session.id, 'task_started', {
      kind: 'skill',
      name: 'save_reviewed_ref',
      runId: run.id,
    });
    kernelSessionRepository.appendEvent(session.id, 'task_completed', {
      kind: 'skill',
      name: 'save_reviewed_ref',
      runId: run.id,
      stopReason: 'completed',
    });
    kernelSessionRepository.appendEvent(session.id, 'run_completed', {
      runId: run.id,
      stopReason: 'completed',
      findings: 99,
    });

    getDatabase()
      .query('DELETE FROM agent_kernel_session_checkpoints WHERE session_id = ?')
      .run(session.id);

    const resumedCheckpoint = await createRuntime().continueExecution(run, session.id);
    const persistedAfterResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );
    const startedTasks = getTaskNames(session.id, 'task_started');
    const completedTasks = getTaskNames(session.id, 'task_completed');
    const runCompletedEvents = getRunCompletedEvents(session.id);

    expect(resumedCheckpoint.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
      reviewCompleted: true,
    });
    expect(resumedCheckpoint.pendingTasks).toEqual([]);
    expect(resumedCheckpoint.stopReason).toBe('completed');
    expect(persistedAfterResume?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
      reviewCompleted: true,
    });
    expect(persistedAfterResume?.pendingTasks).toEqual([]);
    expect(persistedAfterResume?.stopReason).toBe('completed');
    expect(startedTasks).toEqual(
      expect.arrayContaining([
        'save_reviewed_ref',
        'prepare_workspace',
        'build_context',
        REVIEW_TRIAGE_SUBAGENT,
        REVIEW_FULL_REVIEW_SUBAGENT,
        'aggregate_findings',
        'publish_review',
      ])
    );
    expect(completedTasks).toEqual(
      expect.arrayContaining([
        'save_reviewed_ref',
        'prepare_workspace',
        'build_context',
        REVIEW_TRIAGE_SUBAGENT,
        REVIEW_FULL_REVIEW_SUBAGENT,
        'aggregate_findings',
        'publish_review',
      ])
    );
    expect(runCompletedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ stopReason: 'completed', findings: 99 }),
        }),
      ])
    );
    expect(summaryBodies).toHaveLength(1);
    expect(lineCommentCalls).toHaveLength(1);
    expect(savedReviewedRefs).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        prNumber: 401,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
    ]);
  });

  test('resume keeps returned checkpoint and persisted checkpoint invariants aligned', async () => {
    configureFindings('gated');
    const { run, session } = await createRunSession('resume-invariants');

    const firstCheckpoint = await createRuntime().execute(run, session.id);
    const taskStartsBeforeResume = getTaskNames(session.id, 'task_started').length;
    const taskCompletionsBeforeResume = getTaskNames(session.id, 'task_completed').length;
    const cleanedWorkspacesBeforeResume = [...cleanedWorkspaces];

    expect(firstCheckpoint.stopReason).toBe('completed');

    kernelSessionRepository.saveCheckpoint(session.id, {
      state: firstCheckpoint.state,
      pendingTasks: [{ kind: 'skill', name: 'save_reviewed_ref' }],
      stopReason: undefined,
    });

    const resumedCheckpoint = await createRuntime().continueExecution(run, session.id);
    const persistedAfterResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );
    const startedTasks = getTaskNames(session.id, 'task_started').slice(taskStartsBeforeResume);
    const completedTasks = getTaskNames(session.id, 'task_completed').slice(
      taskCompletionsBeforeResume
    );

    expect(persistedAfterResume).not.toBeNull();
    expect(resumedCheckpoint).toEqual(persistedAfterResume!);
    expect(resumedCheckpoint.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
      reviewCompleted: true,
    });
    expect(resumedCheckpoint.pendingTasks).toEqual([]);
    expect(resumedCheckpoint.stopReason).toBe('completed');
    expect(startedTasks.length).toBeGreaterThan(0);
    expect(completedTasks.length).toBeGreaterThan(0);
    expect(savedReviewedRefs).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        prNumber: 401,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        prNumber: 401,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
    ]);
    expect(cleanedWorkspaces).toEqual(cleanedWorkspacesBeforeResume);
  });
});
