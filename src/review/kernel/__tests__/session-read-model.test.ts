import { describe, expect, test } from 'bun:test';
import type {
  KernelCheckpoint,
  KernelSessionEventRecord,
  KernelSessionRecord,
  KernelTask,
  KernelTaskDefinition,
} from '../../../agent-kernel/types';
import { REVIEW_FULL_REVIEW_SUBAGENT, REVIEW_TRIAGE_SUBAGENT } from '../review-subagent-ids';
import {
  buildReviewPlanSnapshot,
  buildReviewSessionSummary,
  buildReviewTimeline,
} from '../session-read-model';

type ReviewCheckpointState = {
  targetSha?: string;
  reviewCompleted?: boolean;
  findings?: Array<{ fingerprint: string }>;
  published?: boolean;
};

function makeSession(overrides: Partial<KernelSessionRecord> = {}): KernelSessionRecord {
  return {
    id: 'session-1',
    scopeType: 'pull_request',
    scopeKey: 'acme/repo#42',
    metadata: {
      owner: 'acme',
      repo: 'repo',
      prNumber: '42',
      headSha: 'metadata-sha',
    },
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:10:00.000Z',
    ...overrides,
  };
}

function makeCheckpoint(
  params: {
    state?: Partial<ReviewCheckpointState>;
    pendingTasks?: KernelTask[];
    stopReason?: string;
  } = {}
): KernelCheckpoint<ReviewCheckpointState> {
  return {
    state: {
      targetSha: 'checkpoint-sha',
      ...params.state,
    },
    pendingTasks: params.pendingTasks ?? [],
    stopReason: params.stopReason,
  };
}

function makeEvent(
  eventType: KernelSessionEventRecord['eventType'],
  payload: Record<string, unknown>,
  id: string
): KernelSessionEventRecord {
  return {
    id,
    sessionId: 'session-1',
    eventType,
    payload,
    createdAt: `2026-04-13T00:00:0${id.slice(-1)}.000Z`,
  };
}

function makeCatalog(): KernelTaskDefinition[] {
  return [
    { kind: 'skill', name: 'prepare_workspace', description: 'custom prepare workspace' },
    { kind: 'skill', name: 'build_context', description: '自定义上下文构建' },
    { kind: 'subagent', name: REVIEW_TRIAGE_SUBAGENT, description: 'custom triage' },
    { kind: 'subagent', name: REVIEW_FULL_REVIEW_SUBAGENT, description: 'custom full review' },
    { kind: 'skill', name: 'aggregate_findings', description: 'custom aggregate' },
    { kind: 'skill', name: 'publish_review', description: 'custom publish' },
    { kind: 'skill', name: 'save_reviewed_ref', description: 'custom save ref' },
  ];
}

describe('session read model', () => {
  test('buildReviewPlanSnapshot projects task states and full review progress', () => {
    const catalog = makeCatalog();
    const checkpoint = makeCheckpoint({
      state: {
        reviewCompleted: false,
      },
      pendingTasks: [
        { kind: 'skill', name: 'prepare_workspace' },
        { kind: 'subagent', name: REVIEW_TRIAGE_SUBAGENT },
      ],
    });
    const events = [
      makeEvent('task_started', { name: 'build_context', kind: 'skill' }, 'e1'),
      makeEvent(
        'task_started',
        { name: REVIEW_FULL_REVIEW_SUBAGENT, kind: 'subagent', agentId: 'agent-123456' },
        'e2'
      ),
      makeEvent(
        'task_completed',
        { name: 'aggregate_findings', kind: 'skill', summary: 'aggregate done' },
        'e3'
      ),
      makeEvent(
        'task_failed',
        { name: 'save_reviewed_ref', kind: 'skill', error: 'persist failed' },
        'e4'
      ),
    ];

    const plan = buildReviewPlanSnapshot(catalog, checkpoint, events);
    const byKey = new Map(plan.map((step) => [step.key, step]));

    expect(byKey.get('prepare_workspace')?.status).toBe('queued');
    expect(byKey.get('build_context')?.status).toBe('running');
    expect(byKey.get('build_context')?.description).toBe('自定义上下文构建');
    expect(byKey.get(REVIEW_TRIAGE_SUBAGENT)?.status).toBe('queued');
    expect(byKey.get('aggregate_findings')?.status).toBe('completed');
    expect(byKey.get('save_reviewed_ref')?.status).toBe('failed');
    expect(byKey.get(REVIEW_FULL_REVIEW_SUBAGENT)?.status).toBe('running');
    expect(byKey.get(REVIEW_FULL_REVIEW_SUBAGENT)?.progressText).toBe('等待 full review');
  });

  test('buildReviewTimeline maps task and feedback events', () => {
    const timeline = buildReviewTimeline([
      makeEvent(
        'task_started',
        { name: 'prepare_workspace', kind: 'skill', agentId: 'agent-abcdef-123' },
        'e1'
      ),
      makeEvent(
        'task_completed',
        { name: 'aggregate_findings', summary: '3 findings triaged', stopReason: 'completed' },
        'e2'
      ),
      makeEvent('task_failed', { name: 'save_reviewed_ref', error: 'write failed' }, 'e3'),
      makeEvent('human_feedback_processed', { approved: false, reason: 'false positive' }, 'e4'),
    ]);

    expect(timeline).toEqual([
      {
        id: 'e1',
        timestamp: '2026-04-13T00:00:01.000Z',
        title: '开始执行 prepare_workspace',
        detail: 'skill 已进入运行阶段 · agent agent-ab',
        tone: 'neutral',
      },
      {
        id: 'e2',
        timestamp: '2026-04-13T00:00:02.000Z',
        title: '完成 aggregate_findings',
        detail: '3 findings triaged · 步骤完成 · completed',
        tone: 'success',
      },
      {
        id: 'e3',
        timestamp: '2026-04-13T00:00:03.000Z',
        title: '失败 save_reviewed_ref',
        detail: 'write failed',
        tone: 'danger',
      },
      {
        id: 'e4',
        timestamp: '2026-04-13T00:00:04.000Z',
        title: '人工反馈已写回',
        detail: 'finding 已标记为误报',
        tone: 'warning',
      },
    ]);
  });

  test('buildReviewSessionSummary derives core session statuses', () => {
    const session = makeSession();
    const planForExecuting = buildReviewPlanSnapshot(
      makeCatalog(),
      makeCheckpoint({ pendingTasks: [{ kind: 'skill', name: 'build_context' }] }),
      [makeEvent('task_started', { name: 'build_context', kind: 'skill' }, 'e1')]
    );
    const planForQueued = buildReviewPlanSnapshot(
      makeCatalog(),
      makeCheckpoint({ pendingTasks: [{ kind: 'skill', name: 'prepare_workspace' }] }),
      []
    );

    const cases = [
      {
        name: 'queued',
        checkpoint: null,
        events: [] as KernelSessionEventRecord[],
        plan: planForQueued,
        expected: {
          status: 'queued',
          currentStep: '准备工作区',
          findingCount: 0,
          pendingTaskCount: 0,
          headSha: 'metadata-sha',
        },
      },
      {
        name: 'executing',
        checkpoint: makeCheckpoint({ pendingTasks: [{ kind: 'skill', name: 'build_context' }] }),
        events: [makeEvent('task_started', { name: 'build_context', kind: 'skill' }, 'e1')],
        plan: planForExecuting,
        expected: {
          status: 'executing',
          currentStep: '构建上下文',
          findingCount: 0,
          pendingTaskCount: 1,
          headSha: 'metadata-sha',
        },
      },
      {
        name: 'awaiting_human_feedback',
        checkpoint: makeCheckpoint({ stopReason: 'awaiting_human_feedback' }),
        events: [],
        plan: [],
        expected: { status: 'awaiting_human_feedback', findingCount: 0, pendingTaskCount: 0 },
      },
      {
        name: 'completed',
        checkpoint: makeCheckpoint({
          stopReason: 'completed',
          state: { findings: [{ fingerprint: 'fp-1' }] },
        }),
        events: [],
        plan: [],
        expected: { status: 'completed', findingCount: 1, pendingTaskCount: 0 },
      },
      {
        name: 'failed',
        checkpoint: makeCheckpoint({
          stopReason: 'failed',
          pendingTasks: [{ kind: 'skill', name: 'publish_review' }],
        }),
        events: [],
        plan: [],
        expected: { status: 'failed', findingCount: 0, pendingTaskCount: 1 },
      },
      {
        name: 'ignored',
        checkpoint: makeCheckpoint({ stopReason: 'missing_target_sha' }),
        events: [],
        plan: [],
        expected: { status: 'ignored', findingCount: 0, pendingTaskCount: 0 },
      },
    ] as const;

    for (const testCase of cases) {
      const events = [...testCase.events];
      const plan = [...testCase.plan];
      const summary = buildReviewSessionSummary(session, testCase.checkpoint, events, plan);

      expect(summary.sessionId).toBe('session-1');
      expect(summary.scopeKey).toBe('acme/repo#42');
      expect(summary.scopeType).toBe('pull_request');
      expect(summary.owner).toBe('acme');
      expect(summary.repo).toBe('repo');
      expect(summary.prNumber).toBe(42);
      expect(summary.status).toBe(testCase.expected.status);
      expect(summary.findingCount).toBe(testCase.expected.findingCount);
      expect(summary.pendingTaskCount).toBe(testCase.expected.pendingTaskCount);

      if ('currentStep' in testCase.expected) {
        expect(summary.currentStep).toBe(testCase.expected.currentStep);
      }

      if ('headSha' in testCase.expected) {
        expect(summary.headSha).toBe(testCase.expected.headSha);
      }
    }
  });
});
