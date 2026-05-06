import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { kernelSessionRepository } from '../../../agent-kernel/session/session-repository';
import { configManager } from '../../../config';
import { feedbackRouter, initializeFeedbackSystem } from '../../../controllers/feedback';
import { closeDatabase, initDatabase } from '../../../db/database';
import { giteaService } from '../../../services/gitea';
import { FileReviewStore } from '../../store/file-review-store';
import type { Finding, PullRequestReviewPayload, ReviewRun } from '../../types';
import { kernelReviewEngine } from '../kernel-review-engine';
import { ReviewKernelRuntime } from '../review-kernel-runtime';
import type { ReviewKernelState } from '../review-kernel-state';
import { getReviewSessionScope } from '../session-scope';

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/feedback', feedbackRouter);
  return app;
}

function createPullRequestPayload(
  keySuffix: string,
  overrides: Partial<PullRequestReviewPayload> = {}
): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:${overrides.prNumber ?? 501}:${keySuffix}`,
    eventType: 'pull_request',
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 501,
    baseSha: 'base-sha',
    headSha: `head-${keySuffix}`,
    maxAttempts: 2,
    ...overrides,
  };
}

function createFinding(runId: string, fingerprint = 'gated-finding'): Finding {
  return {
    id: `${runId}-${fingerprint}`,
    runId,
    fingerprint,
    category: 'correctness',
    severity: 'low',
    confidence: 0.91,
    path: 'src/index.ts',
    line: 2,
    title: 'Need human review',
    detail: 'This finding is intentionally gated for human approval.',
    evidence: 'return input.trim() === "on";',
    suggestion: 'Guard the optional value before trimming.',
    published: false,
  };
}

function createReviewContext(run: ReviewRun) {
  return {
    workspacePath: path.join('/tmp', run.id),
    mirrorPath: path.join('/tmp', 'mirror.git'),
    diff: 'diff --git a/src/index.ts b/src/index.ts',
    changedFiles: [{ path: 'src/index.ts', status: 'M' as const, additions: 1, deletions: 0 }],
    parsedDiff: [
      {
        path: 'src/index.ts',
        changes: [
          { lineNumber: 1, content: 'return input?.trim() === "on";', type: 'add' as const },
        ],
      },
    ],
    fileContents: {
      'src/index.ts':
        'export function checkFlag(input?: string) {\n  return input?.trim() === "on";\n}',
    },
  };
}

function createAwaitingHumanCheckpoint(finding: Finding, run: ReviewRun): ReviewKernelState {
  const pendingFinding = {
    fingerprint: finding.fingerprint,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    path: finding.path,
    line: finding.line,
    title: finding.title,
    detail: finding.detail,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
  };

  return {
    targetSha: run.headSha,
    mirrorPath: path.join('/tmp', 'mirror.git'),
    workspacePath: path.join('/tmp', run.id),
    context: createReviewContext(run),
    projectPrompt: 'test project prompt',
    triage: { tasks: [] } as any,
    domainTasks: [],
    completedDomains: ['correctness'],
    findings: [pendingFinding],
    decision: {
      summaryMarkdown: 'summary already published',
      findings: [pendingFinding],
    },
    policyResult: {
      publishable: [],
      gated: [pendingFinding],
      dropped: [],
    },
    published: true,
    reviewedRefSaved: false,
  };
}

function createCompletedCheckpoint(run: ReviewRun): ReviewKernelState {
  return {
    targetSha: run.headSha,
    mirrorPath: path.join('/tmp', 'mirror.git'),
    workspacePath: path.join('/tmp', run.id),
    context: createReviewContext(run),
    projectPrompt: 'test project prompt',
    triage: { tasks: [] } as any,
    domainTasks: [],
    completedDomains: ['correctness'],
    findings: [],
    decision: {
      summaryMarkdown: 'summary already published',
      findings: [],
    },
    published: true,
    reviewedRefSaved: true,
  };
}

function getTaskNames(sessionId: string, eventType: 'task_started' | 'task_completed'): string[] {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) => event.eventType === eventType)
    .map((event) => String(event.payload.name));
}

function countEventType(sessionId: string, eventType: string): number {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) => event.eventType === eventType).length;
}

async function jsonRequest(app: Hono, findingId: string, approved: boolean, reason?: string) {
  const response = await app.request(`http://localhost/feedback/finding/${findingId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ approved, reason }),
  });

  return {
    response,
    payload: (await response.json()) as Record<string, unknown>,
  };
}

function waitForAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('KernelReviewEngine concurrency and idempotency', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;
  let app: Hono;
  let store: FileReviewStore;
  let pullRequestCommentBodies: string[];
  let saveReviewedRefCalls: Array<{
    mirrorPath: string;
    prNumber: number;
    baseSha: string;
    targetSha: string;
  }>;

  const engine = kernelReviewEngine as any;
  const originalEngineStart = engine.start;
  const originalCreateRuntime = engine.createRuntime;
  const originalStore = engine._store;
  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-concurrency-idempotency-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');

    initDatabase();

    store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
    await store.init();
    initializeFeedbackSystem(store);
    app = createTestApp();
    pullRequestCommentBodies = [];
    saveReviewedRefCalls = [];

    await configManager.resetKeys(['REVIEW_MAX_PARALLEL_RUNS']);

    engine._store = store;
    engine.start = async () => undefined;

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      pullRequestCommentBodies.push(body);
    };
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in these tests');
    };
  });

  afterEach(async () => {
    engine.start = originalEngineStart;
    engine.createRuntime = originalCreateRuntime;
    engine._store = originalStore;
    giteaService.addPullRequestComment = originalAddPullRequestComment;
    giteaService.addCommitComment = originalAddCommitComment;

    await configManager.resetKeys(['REVIEW_MAX_PARALLEL_RUNS']);

    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test('respects maxParallelRuns when multiple queued runs exist', async () => {
    await configManager.setOverrides({ REVIEW_MAX_PARALLEL_RUNS: '1' });

    let inFlight = 0;
    let maxObserved = 0;
    const executeCalls: string[] = [];
    const resolvers = new Map<string, () => void>();

    engine.createRuntime = () => ({
      execute: async (run: ReviewRun, sessionId: string) => {
        executeCalls.push(run.id);
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        kernelSessionRepository.appendEvent(sessionId, 'runtime_execute_started', {
          runId: run.id,
        });

        await new Promise<void>((resolve) => {
          resolvers.set(run.id, resolve);
        });

        kernelSessionRepository.appendEvent(sessionId, 'runtime_execute_completed', {
          runId: run.id,
        });
        inFlight -= 1;
      },
      continueExecution: async () => {
        throw new Error('continueExecution should not be used in maxParallelRuns test');
      },
    });

    const runs = await Promise.all([
      kernelReviewEngine.enqueuePullRequest(
        createPullRequestPayload('parallel-1', { prNumber: 511 })
      ),
      kernelReviewEngine.enqueuePullRequest(
        createPullRequestPayload('parallel-2', { prNumber: 512 })
      ),
      kernelReviewEngine.enqueuePullRequest(
        createPullRequestPayload('parallel-3', { prNumber: 513 })
      ),
    ]);

    await engine.tick();
    await waitForAsyncWork();

    expect(executeCalls).toHaveLength(1);
    expect(maxObserved).toBe(1);
    expect((await store.listRuns()).map((run) => run.status).sort()).toEqual([
      'in_progress',
      'queued',
      'queued',
    ]);

    resolvers.get(runs[0]!.run.id)?.();
    await waitForAsyncWork();
    await engine.tick();
    await waitForAsyncWork();

    expect(executeCalls).toHaveLength(2);
    expect(maxObserved).toBe(1);

    resolvers.get(runs[1]!.run.id)?.();
    await waitForAsyncWork();
    await engine.tick();
    await waitForAsyncWork();

    expect(executeCalls).toHaveLength(3);
    expect(maxObserved).toBe(1);

    resolvers.get(runs[2]!.run.id)?.();
    await waitForAsyncWork();

    expect((await store.listRuns()).every((run) => run.status === 'succeeded')).toBe(true);
  });

  test('duplicate enqueuePullRequest reuses the same run and does not create duplicate effective work', async () => {
    await configManager.setOverrides({ REVIEW_MAX_PARALLEL_RUNS: '1' });

    const executeCalls: string[] = [];
    engine.createRuntime = () => ({
      execute: async (run: ReviewRun) => {
        executeCalls.push(run.id);
        await store.addCommentRecord({
          runId: run.id,
          status: 'published',
          body: 'engine summary',
        });
      },
      continueExecution: async () => {
        throw new Error('continueExecution should not be used in duplicate enqueue test');
      },
    });

    const payload = createPullRequestPayload('duplicate-enqueue', { prNumber: 521 });
    const first = await kernelReviewEngine.enqueuePullRequest(payload);
    const second = await kernelReviewEngine.enqueuePullRequest(payload);
    const session = kernelSessionRepository.getSessionByScopeKey(
      getReviewSessionScope(first.run).scopeKey
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.run.id).toBe(second.run.id);
    expect(await store.listRuns()).toHaveLength(1);
    expect(session).not.toBeNull();
    expect(kernelSessionRepository.listSessions()).toHaveLength(1);

    await engine.tick();
    await waitForAsyncWork();

    const runDetails = await store.getRunDetails(first.run.id);

    expect(executeCalls).toEqual([first.run.id]);
    expect(runDetails?.run.status).toBe('succeeded');
    expect(runDetails?.comments).toHaveLength(1);
    expect(runDetails?.comments[0]?.body).toBe('engine summary');
  });

  test('duplicate continueSession after completion does not repeat completion tasks', async () => {
    const { run } = await store.createOrReuseRun(
      createPullRequestPayload('duplicate-continue', { prNumber: 531 })
    );
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
    kernelSessionRepository.saveCheckpoint(session.id, {
      state: createCompletedCheckpoint(run),
      pendingTasks: [],
      stopReason: 'completed',
    });

    engine.createRuntime = () =>
      new ReviewKernelRuntime(
        store,
        {
          prepareWorkspace: async () => {
            throw new Error('prepareWorkspace should not rerun for completed session');
          },
          resolveReviewedRef: async () => null,
          saveReviewedRef: async (
            mirrorPath: string,
            prNumber: number,
            baseSha: string,
            targetSha: string
          ) => {
            saveReviewedRefCalls.push({ mirrorPath, prNumber, baseSha, targetSha });
          },
          cleanupWorkspace: async () => undefined,
        } as any,
        {
          getSandbox: () => ({
            run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          }),
          buildContext: async () => {
            throw new Error('buildContext should not rerun for completed session');
          },
        } as any
      );

    const first = await kernelReviewEngine.continueSession(session.id);
    const second = await kernelReviewEngine.continueSession(session.id);
    const taskStarts = getTaskNames(session.id, 'task_started');
    const taskCompletions = getTaskNames(session.id, 'task_completed');

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(taskStarts.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(taskCompletions.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(saveReviewedRefCalls).toEqual([]);
    expect(countEventType(session.id, 'session_continue_requested')).toBe(2);
    expect(countEventType(session.id, 'session_continue_completed')).toBe(2);
  });

  test('duplicate feedback approval stays idempotent and does not double publish or double complete', async () => {
    const { run } = await store.createOrReuseRun(
      createPullRequestPayload('duplicate-feedback', { prNumber: 541 })
    );
    const finding = createFinding(run.id);
    await store.addFindings(run.id, [finding]);
    await store.addCommentRecord({
      runId: run.id,
      status: 'published',
      body: '## AI Agent代码审查结果\n\nsummary already published',
    });
    await store.addCommentRecord({
      runId: run.id,
      status: 'pending',
      body: `PENDING: ${finding.title}`,
      path: finding.path,
      line: finding.line,
      fingerprint: finding.fingerprint,
    });

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
    kernelSessionRepository.saveCheckpoint(session.id, {
      state: createAwaitingHumanCheckpoint(finding, run),
      pendingTasks: [],
      stopReason: 'awaiting_human_feedback',
    });

    engine.createRuntime = () =>
      new ReviewKernelRuntime(
        store,
        {
          prepareWorkspace: async () => {
            throw new Error('prepareWorkspace should not rerun during feedback resume');
          },
          resolveReviewedRef: async () => null,
          saveReviewedRef: async (
            mirrorPath: string,
            prNumber: number,
            baseSha: string,
            targetSha: string
          ) => {
            saveReviewedRefCalls.push({ mirrorPath, prNumber, baseSha, targetSha });
          },
          cleanupWorkspace: async () => undefined,
        } as any,
        {
          getSandbox: () => ({
            run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          }),
          buildContext: async () => {
            throw new Error('buildContext should not rerun during feedback resume');
          },
        } as any
      );

    const first = await jsonRequest(app, finding.id, true, 'human approved');
    const second = await jsonRequest(app, finding.id, true, 'retry approval');
    const runDetails = await store.getRunDetails(run.id);
    const persistedCheckpoint = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );
    const taskStarts = getTaskNames(session.id, 'task_started');
    const taskCompletions = getTaskNames(session.id, 'task_completed');

    expect(first.response.status).toBe(200);
    expect(first.payload).toMatchObject({
      success: true,
      published: true,
      learningApplied: false,
    });
    expect(second.response.status).toBe(200);
    expect(second.payload).toMatchObject({
      success: true,
      message: '该finding已处理过',
      alreadyProcessed: true,
      published: true,
      learningApplied: false,
    });
    expect(pullRequestCommentBodies).toHaveLength(1);
    expect(
      runDetails?.comments.filter((comment) => comment.fingerprint === finding.fingerprint)
    ).toHaveLength(2);
    expect(taskStarts.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(taskCompletions.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(countEventType(session.id, 'human_feedback_processed')).toBe(1);
    expect(countEventType(session.id, 'session_continue_requested')).toBe(1);
    expect(countEventType(session.id, 'session_continue_completed')).toBe(1);
    expect(saveReviewedRefCalls).toEqual([
      {
        mirrorPath: path.join('/tmp', 'mirror.git'),
        prNumber: 541,
        baseSha: 'base-sha',
        targetSha: 'head-duplicate-feedback',
      },
    ]);
    expect(persistedCheckpoint?.stopReason).toBe('completed');
    expect(persistedCheckpoint?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
  });
});
