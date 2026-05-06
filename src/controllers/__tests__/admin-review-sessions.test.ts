import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { kernelSessionRepository } from '../../agent-kernel/session/session-repository';
import type { KernelSessionRecord } from '../../agent-kernel/types';
import { closeDatabase, initDatabase } from '../../db/database';
import { kernelReviewEngine } from '../../review/kernel/kernel-review-engine';
import {
  REVIEW_TRIAGE_SUBAGENT,
  getReviewDomainSubagentId,
} from '../../review/kernel/review-subagent-ids';
import { adminController } from '../admin';

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/admin/api', adminController.protectedRoutes);
  return app;
}

function createRunDetails(runId: string) {
  const timestamp = '2026-04-13T10:00:00.000Z';
  return {
    run: {
      id: runId,
      idempotencyKey: 'pr:acme/repo:42:sha-123',
      eventType: 'pull_request' as const,
      status: 'in_progress' as const,
      owner: 'acme',
      repo: 'repo',
      cloneUrl: 'https://example.com/acme/repo.git',
      prNumber: 42,
      baseSha: 'base-sha',
      headSha: 'sha-123',
      commitSha: 'sha-123',
      attempts: 0,
      maxAttempts: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
    },
    steps: [
      {
        id: 'step-1',
        runId,
        stepName: 'prepare_workspace',
        status: 'succeeded' as const,
        startedAt: timestamp,
        finishedAt: '2026-04-13T10:00:10.000Z',
        latencyMs: 10,
      },
      {
        id: 'step-2',
        runId,
        stepName: REVIEW_TRIAGE_SUBAGENT,
        agentName: REVIEW_TRIAGE_SUBAGENT,
        status: 'started' as const,
        startedAt: '2026-04-13T10:00:11.000Z',
      },
    ],
    findings: [
      {
        id: 'finding-1',
        runId,
        fingerprint: 'fp-1',
        category: 'correctness' as const,
        severity: 'high' as const,
        confidence: 0.98,
        path: 'src/index.ts',
        line: 12,
        title: 'Potential null dereference',
        detail: 'Value can be undefined before access.',
        evidence: 'line 12 reads target.value without guard',
        suggestion: 'Guard the value before use.',
        published: false,
      },
    ],
    comments: [
      {
        id: 'comment-1',
        runId,
        path: 'src/index.ts',
        line: 12,
        body: 'Please add a null guard here.',
        status: 'published' as const,
        createdAt: timestamp,
        fingerprint: 'fp-1',
      },
    ],
  };
}

function seedReviewSession(): { session: KernelSessionRecord; runId: string } {
  const runId = 'run-42';
  const session = kernelSessionRepository.ensureSession({
    scopeType: 'pull_request',
    scopeKey: 'acme/repo#42',
    metadata: {
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      headSha: 'sha-123',
    },
    runId,
  });

  kernelSessionRepository.appendEvent(session.id, 'task_started', {
    name: 'prepare_workspace',
    kind: 'skill',
    agentId: 'agent-prepare-123456',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_completed', {
    name: 'prepare_workspace',
    kind: 'skill',
    summary: 'workspace ready',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_started', {
    name: 'build_context',
    kind: 'skill',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_completed', {
    name: 'build_context',
    kind: 'skill',
    summary: 'diff captured',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_started', {
    name: REVIEW_TRIAGE_SUBAGENT,
    kind: 'subagent',
    agentId: 'agent-triage-abcdef',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_completed', {
    name: REVIEW_TRIAGE_SUBAGENT,
    kind: 'subagent',
    summary: 'domain plan created',
  });

  const domainSubagent = getReviewDomainSubagentId('correctness');
  kernelSessionRepository.appendEvent(session.id, 'task_started', {
    name: domainSubagent,
    kind: 'subagent',
    agentId: 'agent-domain-abcdef',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_completed', {
    name: domainSubagent,
    kind: 'subagent',
    summary: 'correctness pass done',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_started', {
    name: 'aggregate_findings',
    kind: 'skill',
  });
  kernelSessionRepository.appendEvent(session.id, 'task_completed', {
    name: 'aggregate_findings',
    kind: 'skill',
    summary: '2 findings triaged',
    stopReason: 'completed',
  });
  kernelSessionRepository.appendEvent(session.id, 'human_feedback_processed', {
    approved: true,
    fingerprint: 'fp-1',
  });

  kernelSessionRepository.saveCheckpoint(session.id, {
    state: {
      targetSha: 'sha-123',
      domainTasks: [{ domain: 'correctness' }],
      completedDomains: ['correctness'],
      findings: [{ fingerprint: 'fp-1' }, { fingerprint: 'fp-2' }],
      published: false,
    },
    pendingTasks: [{ kind: 'skill', name: 'publish_review' }],
  });

  const invocation = kernelSessionRepository.createSubagentInvocation({
    parentSessionId: session.id,
    parentRunId: runId,
    parentTaskName: domainSubagent,
    subagentName: domainSubagent,
    agentId: 'agent-domain-abcdef',
    packet: {
      goal: 'Review correctness risks in changed files',
      parentTaskName: domainSubagent,
      input: { domain: 'correctness', paths: ['src/index.ts'] },
      parentSessionId: session.id,
      parentRunId: runId,
      contextSummary: 'Focus on nullable flow and async boundaries.',
    },
  });

  kernelSessionRepository.completeSubagentInvocation(invocation.id, 'completed', {
    agentId: 'agent-domain-abcdef',
    agentType: domainSubagent,
    summary: 'Found 2 correctness concerns',
    totalDurationMs: 25,
    totalToolUseCount: 3,
    totalTokens: 1200,
    artifacts: { findings: ['fp-1', 'fp-2'] },
  });

  return { session, runId };
}

describe('admin review session routes', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;
  const originalGetRunDetails = kernelReviewEngine.getRunDetails;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'admin-review-sessions-db-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
    initDatabase();
    kernelReviewEngine.getRunDetails = async (runId: string) => createRunDetails(runId);
  });

  afterEach(async () => {
    kernelReviewEngine.getRunDetails = originalGetRunDetails;
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('GET /admin/api/review/sessions returns projected summaries from persisted history', async () => {
    seedReviewSession();
    const app = createTestApp();

    const response = await app.request('http://localhost/admin/api/review/sessions?limit=10');
    const payload = (await response.json()) as {
      data: Array<{
        session: KernelSessionRecord;
        summary: {
          status: string;
          currentStep?: string;
          findingCount: number;
          pendingTaskCount: number;
          owner?: string;
          repo?: string;
          prNumber?: number;
          headSha?: string;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]?.session.scopeKey).toBe('acme/repo#42');
    expect(payload.data[0]?.summary.status).toBe('executing');
    expect(payload.data[0]?.summary.currentStep).toBe('发布结果');
    expect(payload.data[0]?.summary.findingCount).toBe(2);
    expect(payload.data[0]?.summary.pendingTaskCount).toBe(1);
    expect(payload.data[0]?.summary.owner).toBe('acme');
    expect(payload.data[0]?.summary.repo).toBe('repo');
    expect(payload.data[0]?.summary.prNumber).toBe(42);
    expect(payload.data[0]?.summary.headSha).toBe('sha-123');
  });

  test('GET /admin/api/review/sessions/:sessionId returns checkpoint plan timeline subagent invocations and run details', async () => {
    const { session, runId } = seedReviewSession();
    const app = createTestApp();

    const response = await app.request(`http://localhost/admin/api/review/sessions/${session.id}`);
    const payload = (await response.json()) as {
      session: KernelSessionRecord;
      summary: {
        status: string;
        currentStep?: string;
        findingCount: number;
        pendingTaskCount: number;
      };
      checkpoint: {
        state: {
          targetSha: string;
          domainTasks: Array<{ domain: string }>;
          completedDomains: string[];
          findings: Array<{ fingerprint: string }>;
          published: boolean;
        };
        pendingTasks: Array<{ kind: string; name: string }>;
      };
      plan: Array<{ key: string; label: string; status: string; progressText?: string }>;
      timeline: Array<{ title: string; detail: string; tone: string }>;
      subagentInvocations: Array<{
        parentRunId: string;
        subagentName: string;
        status: string;
        input: { goal: string; contextSummary?: string; input: Record<string, unknown> };
        result?: { summary: string; totalDurationMs: number; totalToolUseCount: number };
      }>;
      runDetails: ReturnType<typeof createRunDetails>;
    };

    expect(response.status).toBe(200);
    expect(payload.session.id).toBe(session.id);
    expect(payload.summary.status).toBe('executing');
    expect(payload.summary.currentStep).toBe('发布结果');
    expect(payload.summary.findingCount).toBe(2);
    expect(payload.summary.pendingTaskCount).toBe(1);

    expect(payload.checkpoint.state.targetSha).toBe('sha-123');
    expect(payload.checkpoint.state.domainTasks).toEqual([{ domain: 'correctness' }]);
    expect(payload.checkpoint.state.completedDomains).toEqual(['correctness']);
    expect(payload.checkpoint.state.findings.map((finding) => finding.fingerprint)).toEqual([
      'fp-1',
      'fp-2',
    ]);
    expect(payload.checkpoint.state.published).toBe(false);
    expect(payload.checkpoint.pendingTasks).toEqual([{ kind: 'skill', name: 'publish_review' }]);

    const planByKey = new Map(payload.plan.map((step) => [step.key, step]));
    expect(planByKey.get('prepare_workspace')).toMatchObject({
      label: '准备工作区',
      status: 'completed',
    });
    expect(planByKey.get('build_context')).toMatchObject({
      label: '构建上下文',
      status: 'completed',
    });
    expect(planByKey.get(REVIEW_TRIAGE_SUBAGENT)).toMatchObject({
      label: '制定执行计划',
      status: 'completed',
    });
    expect(planByKey.get('review-domain')).toMatchObject({
      label: '专项子代理审查',
      status: 'completed',
      progressText: '1/1 domains',
    });
    expect(planByKey.get('aggregate_findings')).toMatchObject({
      label: '聚合与筛选',
      status: 'completed',
    });
    expect(planByKey.get('publish_review')).toMatchObject({
      label: '发布结果',
      status: 'queued',
    });

    expect(payload.timeline.length).toBeGreaterThanOrEqual(6);
    expect(
      payload.timeline.some(
        (entry) => entry.title === '开始执行 prepare_workspace' && entry.tone === 'neutral'
      )
    ).toBe(true);
    expect(payload.timeline.some((entry) => entry.detail.includes('workspace ready'))).toBe(true);
    expect(payload.timeline.some((entry) => entry.title === '人工反馈已写回')).toBe(true);
    expect(payload.timeline.some((entry) => entry.detail.includes('finding 已确认发布'))).toBe(
      true
    );

    expect(payload.subagentInvocations).toHaveLength(1);
    expect(payload.subagentInvocations[0]).toMatchObject({
      parentRunId: runId,
      subagentName: getReviewDomainSubagentId('correctness'),
      status: 'completed',
      input: {
        goal: 'Review correctness risks in changed files',
        contextSummary: 'Focus on nullable flow and async boundaries.',
      },
    });
    expect(payload.subagentInvocations[0]?.input.input).toEqual({
      domain: 'correctness',
      paths: ['src/index.ts'],
    });
    expect(payload.subagentInvocations[0]?.result).toMatchObject({
      summary: 'Found 2 correctness concerns',
      totalDurationMs: 25,
      totalToolUseCount: 3,
    });

    expect(payload.runDetails.run).toMatchObject({
      id: runId,
      status: 'in_progress',
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      headSha: 'sha-123',
    });
    expect(payload.runDetails.steps).toHaveLength(2);
    expect(payload.runDetails.steps[0]).toMatchObject({
      stepName: 'prepare_workspace',
      status: 'succeeded',
    });
    expect(payload.runDetails.findings[0]).toMatchObject({
      fingerprint: 'fp-1',
      category: 'correctness',
      severity: 'high',
    });
    expect(payload.runDetails.comments[0]).toMatchObject({
      fingerprint: 'fp-1',
      status: 'published',
    });
  });

  test('GET /admin/api/review/kernel catalog routes return arrays', async () => {
    const app = createTestApp();

    const tasksResponse = await app.request('http://localhost/admin/api/review/kernel/tasks');
    const subagentsResponse = await app.request(
      'http://localhost/admin/api/review/kernel/subagents'
    );
    const hooksResponse = await app.request('http://localhost/admin/api/review/kernel/hooks');

    const tasksPayload = (await tasksResponse.json()) as { data: unknown[] };
    const subagentsPayload = (await subagentsResponse.json()) as { data: unknown[] };
    const hooksPayload = (await hooksResponse.json()) as { data: unknown[] };

    expect(tasksResponse.status).toBe(200);
    expect(subagentsResponse.status).toBe(200);
    expect(hooksResponse.status).toBe(200);
    expect(Array.isArray(tasksPayload.data)).toBe(true);
    expect(Array.isArray(subagentsPayload.data)).toBe(true);
    expect(Array.isArray(hooksPayload.data)).toBe(true);
    expect(tasksPayload.data.length).toBeGreaterThan(0);
    expect(subagentsPayload.data.length).toBeGreaterThan(0);
    expect(hooksPayload.data.length).toBeGreaterThan(0);
  });
});
