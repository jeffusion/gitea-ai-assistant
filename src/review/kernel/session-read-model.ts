import type {
  KernelCheckpoint,
  KernelSessionEventRecord,
  KernelSessionRecord,
  KernelTaskDefinition,
} from '../../agent-kernel/types';
import { REVIEW_TRIAGE_SUBAGENT, getReviewDomainSubagentId } from './review-subagent-ids';

type SessionStatus =
  | 'queued'
  | 'planning'
  | 'executing'
  | 'awaiting_human_feedback'
  | 'completed'
  | 'failed'
  | 'ignored';

interface ReviewKernelCheckpointState {
  targetSha?: string;
  domainTasks?: Array<{ domain: string }>;
  completedDomains?: string[];
  findings?: Array<{ fingerprint: string }>;
  published?: boolean;
}

export interface ReviewPlanStepSnapshot {
  key: string;
  label: string;
  description: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  progressText?: string;
}

export interface ReviewTimelineEntry {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export interface ReviewSessionSummary {
  sessionId: string;
  scopeKey: string;
  scopeType: KernelSessionRecord['scopeType'];
  owner?: string;
  repo?: string;
  prNumber?: number;
  headSha?: string;
  status: SessionStatus;
  currentStep?: string;
  findingCount: number;
  pendingTaskCount: number;
  updatedAt: string;
}

const PLAN_BLUEPRINT: Array<{
  key: string;
  matches(taskName: string): boolean;
  label: string;
  description: string;
}> = [
  {
    key: 'prepare_workspace',
    matches: (taskName) => taskName === 'prepare_workspace',
    label: '准备工作区',
    description: '创建 mirror/worktree 并恢复增量基线',
  },
  {
    key: 'build_context',
    matches: (taskName) => taskName === 'build_context',
    label: '构建上下文',
    description: '提取 diff、文件内容与项目提示词',
  },
  {
    key: REVIEW_TRIAGE_SUBAGENT,
    matches: (taskName) => taskName === REVIEW_TRIAGE_SUBAGENT,
    label: '制定执行计划',
    description: '根据风险和规模决定审查域与模式',
  },
  {
    key: 'review-domain',
    matches: (taskName) =>
      taskName.startsWith(getReviewDomainSubagentId('correctness').split('correctness')[0]),
    label: '专项子代理审查',
    description: '按域执行 correctness / security / quality',
  },
  {
    key: 'aggregate_findings',
    matches: (taskName) => taskName === 'aggregate_findings',
    label: '聚合与筛选',
    description: '汇总 findings 并应用发布策略',
  },
  {
    key: 'publish_review',
    matches: (taskName) => taskName === 'publish_review',
    label: '发布结果',
    description: '发布 summary / line comments / 待审批记录',
  },
  {
    key: 'save_reviewed_ref',
    matches: (taskName) => taskName === 'save_reviewed_ref',
    label: '保存会话基线',
    description: '记录当前 PR head 供增量继续审查',
  },
];

function countTaskEvents(
  events: KernelSessionEventRecord[],
  eventType: string,
  matcher: (taskName: string) => boolean
): number {
  return events.filter(
    (event) =>
      event.eventType === eventType &&
      typeof event.payload.name === 'string' &&
      matcher(event.payload.name)
  ).length;
}

function deriveSessionStatus(
  checkpoint: KernelCheckpoint<unknown> | null,
  events: KernelSessionEventRecord[]
): SessionStatus {
  switch (checkpoint?.stopReason) {
    case 'awaiting_human_feedback':
      return 'awaiting_human_feedback';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'empty_diff':
      return 'completed';
    case 'missing_target_sha':
      return 'ignored';
    default:
      break;
  }

  if (events.some((event) => event.eventType === 'task_started')) {
    return checkpoint?.pendingTasks.length ? 'executing' : 'planning';
  }

  return 'queued';
}

export function buildReviewPlanSnapshot(
  catalog: KernelTaskDefinition[],
  checkpoint: KernelCheckpoint<unknown> | null,
  events: KernelSessionEventRecord[]
): ReviewPlanStepSnapshot[] {
  const catalogMap = new Map(catalog.map((item) => [item.name, item]));
  const state = checkpoint?.state as ReviewKernelCheckpointState | undefined;
  const totalDomains = state?.domainTasks?.length ?? 0;
  const completedDomains = state?.completedDomains?.length ?? 0;

  return PLAN_BLUEPRINT.map((step) => {
    const completedCount = countTaskEvents(events, 'task_completed', step.matches);
    const startedCount = countTaskEvents(events, 'task_started', step.matches);
    const failedCount = countTaskEvents(events, 'task_failed', step.matches);
    const queued = checkpoint?.pendingTasks.some((task) => step.matches(task.name)) ?? false;

    let status: ReviewPlanStepSnapshot['status'] = 'pending';
    let progressText: string | undefined;

    if (step.key === 'review-domain') {
      progressText =
        totalDomains > 0 ? `${completedDomains}/${totalDomains} domains` : '等待 triage';
      if (failedCount > 0) {
        status = 'failed';
      } else if (totalDomains > 0 && completedDomains >= totalDomains) {
        status = 'completed';
      } else if (startedCount > completedCount || queued) {
        status = startedCount > completedCount ? 'running' : 'queued';
      } else {
        status = totalDomains > 0 ? 'queued' : 'pending';
      }
    } else if (failedCount > 0) {
      status = 'failed';
    } else if (completedCount > 0) {
      status = 'completed';
    } else if (startedCount > completedCount) {
      status = 'running';
    } else if (queued) {
      status = 'queued';
    }

    return {
      key: step.key,
      label: step.label,
      description: catalogMap.get(step.key)?.description ?? step.description,
      status,
      progressText,
    };
  });
}

export function buildReviewTimeline(events: KernelSessionEventRecord[]): ReviewTimelineEntry[] {
  return events.map((event) => {
    const taskName = typeof event.payload.name === 'string' ? event.payload.name : undefined;

    if (event.eventType === 'task_started') {
      return {
        id: event.id,
        timestamp: event.createdAt,
        title: `开始执行 ${taskName ?? 'task'}`,
        detail: `${event.payload.kind ?? 'task'} 已进入运行阶段${event.payload.agentId ? ` · agent ${String(event.payload.agentId).slice(0, 8)}` : ''}`,
        tone: 'neutral',
      };
    }
    if (event.eventType === 'task_completed') {
      return {
        id: event.id,
        timestamp: event.createdAt,
        title: `完成 ${taskName ?? 'task'}`,
        detail: `${event.payload.summary ? `${String(event.payload.summary)} · ` : ''}步骤完成${event.payload.stopReason ? ` · ${String(event.payload.stopReason)}` : ''}`,
        tone: 'success',
      };
    }
    if (event.eventType === 'task_failed') {
      return {
        id: event.id,
        timestamp: event.createdAt,
        title: `失败 ${taskName ?? 'task'}`,
        detail: String(event.payload.error ?? 'unknown error'),
        tone: 'danger',
      };
    }
    if (event.eventType === 'human_feedback_processed') {
      return {
        id: event.id,
        timestamp: event.createdAt,
        title: '人工反馈已写回',
        detail: event.payload.approved ? 'finding 已确认发布' : 'finding 已标记为误报',
        tone: event.payload.approved ? 'success' : 'warning',
      };
    }

    return {
      id: event.id,
      timestamp: event.createdAt,
      title: event.eventType,
      detail: JSON.stringify(event.payload),
      tone: 'neutral',
    };
  });
}

export function filterEventsByLatestHeadSha(
  events: KernelSessionEventRecord[],
  checkpoint: KernelCheckpoint<unknown> | null
): KernelSessionEventRecord[] {
  const state = checkpoint?.state as ReviewKernelCheckpointState | undefined;
  const latestSha = state?.targetSha;
  if (!latestSha || events.length === 0) return events;

  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i].payload;
    const stateObj =
      typeof payload.state === 'object' && payload.state !== null
        ? (payload.state as Record<string, unknown>)
        : null;
    if (
      (typeof payload.headSha === 'string' && payload.headSha === latestSha) ||
      (stateObj && typeof stateObj.targetSha === 'string' && stateObj.targetSha === latestSha)
    ) {
      return events.slice(i);
    }
  }

  return events;
}

export function buildReviewSessionSummary(
  session: KernelSessionRecord,
  checkpoint: KernelCheckpoint<unknown> | null,
  events: KernelSessionEventRecord[],
  plan: ReviewPlanStepSnapshot[]
): ReviewSessionSummary {
  const state = checkpoint?.state as ReviewKernelCheckpointState | undefined;

  return {
    sessionId: session.id,
    scopeKey: session.scopeKey,
    scopeType: session.scopeType,
    owner: typeof session.metadata.owner === 'string' ? session.metadata.owner : undefined,
    repo: typeof session.metadata.repo === 'string' ? session.metadata.repo : undefined,
    prNumber:
      typeof session.metadata.prNumber === 'number'
        ? session.metadata.prNumber
        : typeof session.metadata.prNumber === 'string'
          ? Number(session.metadata.prNumber)
          : undefined,
    headSha:
      typeof session.metadata.headSha === 'string' ? session.metadata.headSha : state?.targetSha,
    status: deriveSessionStatus(checkpoint, events),
    currentStep: plan.find((step) => step.status === 'running' || step.status === 'queued')?.label,
    findingCount: state?.findings?.length ?? 0,
    pendingTaskCount: checkpoint?.pendingTasks.length ?? 0,
    updatedAt: session.updatedAt,
  };
}
