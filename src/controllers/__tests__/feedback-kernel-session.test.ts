import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { kernelSessionRepository } from '../../agent-kernel/session/session-repository';
import type { KernelSessionEventRecord, KernelSessionRecord } from '../../agent-kernel/types';
import { closeDatabase, initDatabase } from '../../db/database';
import { kernelReviewEngine } from '../../review/kernel/kernel-review-engine';
import { getReviewSessionScope } from '../../review/kernel/session-scope';
import { FileReviewStore } from '../../review/store/file-review-store';
import type {
  Finding,
  PullRequestReviewPayload,
  ReviewCommentRecord,
  ReviewRun,
} from '../../review/types';
import { giteaService } from '../../services/gitea';
import { feedbackRouter, initializeFeedbackSystem } from '../feedback';

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/feedback', feedbackRouter);
  return app;
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

function createPullRequestPayload(keySuffix: string): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:42:${keySuffix}`,
    eventType: 'pull_request',
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 42,
    baseSha: 'base-sha',
    headSha: `head-${keySuffix}`,
    maxAttempts: 2,
  };
}

function createFinding(runId: string, index: number): Finding {
  return {
    id: `finding-${index}`,
    runId,
    fingerprint: `fp-${index}`,
    category: 'correctness',
    severity: index === 1 ? 'high' : 'medium',
    confidence: index === 1 ? 0.99 : 0.91,
    path: 'src/index.ts',
    line: 10 + index,
    title: `Potential issue ${index}`,
    detail: `Detail for finding ${index}`,
    evidence: `Evidence for finding ${index}`,
    suggestion: `Suggestion for finding ${index}`,
    published: false,
  };
}

async function seedRunWithSession(
  store: FileReviewStore,
  options: { keySuffix: string; findingCount?: number }
): Promise<{
  run: ReviewRun;
  findings: Finding[];
  session: KernelSessionRecord;
}> {
  const payload = createPullRequestPayload(options.keySuffix);
  const { run } = await store.createOrReuseRun(payload);
  const findings = Array.from({ length: options.findingCount ?? 1 }, (_, index) =>
    createFinding(run.id, index + 1)
  );

  await store.addFindings(run.id, findings);

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

  return { run, findings, session };
}

function getRelevantEvents(sessionId: string): KernelSessionEventRecord[] {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) =>
      [
        'human_feedback_processed',
        'session_continue_requested',
        'session_continue_completed',
      ].includes(event.eventType)
    );
}

function getEventByType(
  events: KernelSessionEventRecord[],
  eventType: KernelSessionEventRecord['eventType']
): KernelSessionEventRecord | undefined {
  return events.find((event) => event.eventType === eventType);
}

describe('feedback kernel session integration', () => {
  let tempDir: string;
  let app: Hono;
  let store: FileReviewStore;
  let savedDbPath: string | undefined;
  let pullRequestCommentCalls: string[];
  let commitCommentCalls: string[];
  let continueSessionCalls: string[];

  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;
  const originalContinueSession = kernelReviewEngine.continueSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'feedback-kernel-session-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');

    initDatabase();

    store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
    await store.init();
    initializeFeedbackSystem(store);

    app = createTestApp();
    pullRequestCommentCalls = [];
    commitCommentCalls = [];
    continueSessionCalls = [];

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      pullRequestCommentCalls.push(body);
    };
    giteaService.addCommitComment = async (_owner, _repo, _commitSha, body) => {
      commitCommentCalls.push(body);
    };
    kernelReviewEngine.continueSession = async (sessionId: string) => {
      continueSessionCalls.push(sessionId);
      const session = kernelSessionRepository.getSessionById(sessionId);
      if (!session?.lastRunId) {
        return false;
      }
      kernelSessionRepository.appendEvent(sessionId, 'session_continue_requested', {
        runId: session.lastRunId,
      });
      kernelSessionRepository.appendEvent(sessionId, 'session_continue_completed', {
        runId: session.lastRunId,
      });
      return true;
    };
  });

  afterEach(async () => {
    giteaService.addPullRequestComment = originalAddPullRequestComment;
    giteaService.addCommitComment = originalAddCommitComment;
    kernelReviewEngine.continueSession = originalContinueSession;

    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test('approve success publishes comment records events and triggers continuation when last pending finding is processed', async () => {
    const { run, findings, session } = await seedRunWithSession(store, {
      keySuffix: 'approve-success',
    });

    const { response, payload } = await jsonRequest(app, findings[0].id, true, 'needs fix');
    const runDetails = await store.getRunDetails(run.id);
    const persistedFinding = await store.getFinding(findings[0].id);
    const events = getRelevantEvents(session.id);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      message: '已标记为有效问题并发布到Gitea',
      published: true,
    });
    expect(persistedFinding?.published).toBe(true);
    expect(runDetails?.comments).toHaveLength(1);
    expect(runDetails?.comments[0]).toMatchObject({
      runId: run.id,
      status: 'published',
      path: findings[0].path,
      line: findings[0].line,
      fingerprint: findings[0].fingerprint,
    } satisfies Partial<ReviewCommentRecord>);
    expect(runDetails?.comments[0]?.body).toContain('人工审批确认');
    expect(runDetails?.comments[0]?.body).toContain(findings[0].title);
    expect(pullRequestCommentCalls).toHaveLength(1);
    expect(commitCommentCalls).toHaveLength(0);
    expect(continueSessionCalls).toEqual([session.id]);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'human_feedback_processed',
      'session_continue_completed',
      'session_continue_requested',
    ]);
    expect(getEventByType(events, 'human_feedback_processed')?.payload).toEqual({
      runId: run.id,
      findingId: findings[0].id,
      approved: true,
      reason: 'needs fix',
      published: true,
    });
    expect(getEventByType(events, 'session_continue_requested')?.payload).toEqual({
      runId: run.id,
    });
    expect(getEventByType(events, 'session_continue_completed')?.payload).toEqual({
      runId: run.id,
    });
  });

  test('reject success records local handling without Gitea publish and still triggers continuation on final pending finding', async () => {
    const { run, findings, session } = await seedRunWithSession(store, {
      keySuffix: 'reject-success',
    });

    const { response, payload } = await jsonRequest(app, findings[0].id, false, 'false positive');
    const runDetails = await store.getRunDetails(run.id);
    const persistedFinding = await store.getFinding(findings[0].id);
    const events = getRelevantEvents(session.id);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      message: '已标记为误报',
      published: false,
    });
    expect(persistedFinding?.published).toBe(true);
    expect(runDetails?.comments).toHaveLength(1);
    expect(runDetails?.comments[0]).toMatchObject({
      runId: run.id,
      status: 'published',
      fingerprint: findings[0].fingerprint,
    } satisfies Partial<ReviewCommentRecord>);
    expect(runDetails?.comments[0]?.body).toBe(`REJECTED: ${findings[0].title} - false positive`);
    expect(pullRequestCommentCalls).toHaveLength(0);
    expect(commitCommentCalls).toHaveLength(0);
    expect(continueSessionCalls).toEqual([session.id]);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'human_feedback_processed',
      'session_continue_completed',
      'session_continue_requested',
    ]);
    expect(getEventByType(events, 'human_feedback_processed')?.payload).toEqual({
      runId: run.id,
      findingId: findings[0].id,
      approved: false,
      reason: 'false positive',
      published: false,
    });
  });

  test('duplicate approve returns idempotent success without duplicating comment records or continuation events', async () => {
    const { run, findings, session } = await seedRunWithSession(store, {
      keySuffix: 'duplicate-approve',
    });

    const first = await jsonRequest(app, findings[0].id, true, 'needs fix');
    const second = await jsonRequest(app, findings[0].id, true, 'retry request');
    const runDetails = await store.getRunDetails(run.id);
    const events = getRelevantEvents(session.id);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(second.payload).toMatchObject({
      success: true,
      message: '该finding已处理过',
      alreadyProcessed: true,
      published: true,
    });
    expect(runDetails?.comments).toHaveLength(1);
    expect(runDetails?.comments[0]?.fingerprint).toBe(findings[0].fingerprint);
    expect(pullRequestCommentCalls).toHaveLength(1);
    expect(continueSessionCalls).toEqual([session.id]);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'human_feedback_processed',
      'session_continue_completed',
      'session_continue_requested',
    ]);
  });

  test('Gitea publish failure rolls back published flag and leaves no local comment record or session events', async () => {
    const { run, findings, session } = await seedRunWithSession(store, {
      keySuffix: 'gitea-fail',
    });

    giteaService.addPullRequestComment = async () => {
      throw new Error('gitea unavailable');
    };

    const { response, payload } = await jsonRequest(app, findings[0].id, true, 'needs fix');
    const runDetails = await store.getRunDetails(run.id);
    const persistedFinding = await store.getFinding(findings[0].id);
    const events = getRelevantEvents(session.id);

    expect(response.status).toBe(500);
    expect(payload).toMatchObject({
      error: 'Failed to process feedback',
      details: 'gitea unavailable',
    });
    expect(persistedFinding?.published).toBe(false);
    expect(runDetails?.comments).toEqual([]);
    expect(events).toEqual([]);
    expect(continueSessionCalls).toEqual([]);
  });

  test('local comment record failure rolls back published flag after Gitea publish and leaves no session events', async () => {
    const { run, findings, session } = await seedRunWithSession(store, {
      keySuffix: 'local-record-fail',
    });
    const originalAddCommentRecord = store.addCommentRecord.bind(store);

    store.addCommentRecord = async () => {
      throw new Error('local store write failed');
    };

    const { response, payload } = await jsonRequest(app, findings[0].id, true, 'needs fix');
    const runDetails = await store.getRunDetails(run.id);
    const persistedFinding = await store.getFinding(findings[0].id);
    const events = getRelevantEvents(session.id);

    store.addCommentRecord = originalAddCommentRecord;

    expect(response.status).toBe(500);
    expect(payload).toMatchObject({
      error: 'Failed to process feedback',
      details:
        'Comment published to Gitea but failed to save locally. State rolled back, you may retry. Note: immediate retry may create duplicate comments.',
    });
    expect(persistedFinding?.published).toBe(false);
    expect(runDetails?.comments).toEqual([]);
    expect(pullRequestCommentCalls).toHaveLength(1);
    expect(events).toEqual([]);
    expect(continueSessionCalls).toEqual([]);
  });
});
