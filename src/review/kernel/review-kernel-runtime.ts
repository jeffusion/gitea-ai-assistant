import { randomUUID } from 'node:crypto';
import { KernelAgentInvoker } from '../../agent-kernel/agents/kernel-agent-invoker';
import { KernelAgentRegistry } from '../../agent-kernel/agents/kernel-agent-registry';
import { KernelHookRegistry } from '../../agent-kernel/hooks/kernel-hook-registry';
import { runKernelHooks } from '../../agent-kernel/hooks/kernel-hook-runner';
import { KernelTaskRegistry } from '../../agent-kernel/registry/kernel-task-registry';
import { AgentKernelRunner } from '../../agent-kernel/runtime/agent-kernel-runner';
import { kernelSessionRepository } from '../../agent-kernel/session/session-repository';
import type {
  KernelCheckpoint,
  KernelPlanningContext,
  KernelTask,
  KernelTaskDefinition,
  KernelTaskHandler,
  KernelTurnPlanner,
} from '../../agent-kernel/types';
import { llmGateway } from '../../llm/gateway';
import { giteaService } from '../../services/gitea';
import { DiffExtractor } from '../context/diff-extractor';
import type { LocalRepoManager } from '../context/local-repo-manager';
import { resolveProjectReviewPrompt } from '../project-review-prompt';
import type { FileReviewStore } from '../store/file-review-store';
import { createCodeSearchTool } from '../tools/code-search-tool';
import { createFileReadTool } from '../tools/file-read-tool';
import { createFunctionReferenceSearchTool } from '../tools/function-reference-search-tool';
import { ToolRegistry } from '../tools/registry';
import type { ReviewRun } from '../types';
import { ContextCompressionService } from './context-compression-service';
import { createReviewBuiltInSubagents } from './review-built-in-subagents';
import type { PendingFinding, ReviewKernelState } from './review-kernel-state';
import { REVIEW_FULL_REVIEW_SUBAGENT } from './review-subagent-ids';

interface LineCommentInput {
  path: string;
  line: number;
  comment: string;
}

function summarizeGatedCount(gatedCount: number): string {
  if (gatedCount <= 0) {
    return '';
  }
  return `\n\n> 另有 ${gatedCount} 条问题需要人工确认后再处理。`;
}

const SEVERITY_LABEL: Record<string, string> = {
  high: '必须优先处理',
  medium: '建议处理',
  low: '可选优化',
};

const CATEGORY_LABEL: Record<string, string> = {
  correctness: '功能正确性',
  security: '安全',
  quality: '代码质量',
};

function getSeverityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? '建议处理';
}

function getCategoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

function findingToLineComment(finding: PendingFinding): LineCommentInput {
  return {
    path: finding.path,
    line: finding.line,
    comment: [
      `**${finding.title}**`,
      '',
      finding.detail,
      '',
      `建议：${finding.suggestion}`,
      '',
      `_优先级：${getSeverityLabel(finding.severity)} · 类型：${getCategoryLabel(finding.category)}_`,
    ].join('\n'),
  };
}

function severityWeight(finding: { severity: string }): number {
  if (finding.severity === 'high') {
    return 3;
  }
  if (finding.severity === 'medium') {
    return 2;
  }
  return 1;
}

function findingWeight(finding: PendingFinding): number {
  return severityWeight(finding) * finding.confidence;
}

function tokenizeFindingText(finding: PendingFinding): Set<string> {
  const normalized =
    `${finding.title}\n${finding.detail}\n${finding.evidence}\n${finding.suggestion}`
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, ' ')
      .trim();
  const tokens = new Set<string>();

  for (const token of normalized.split(/\s+/u)) {
    if (!token) continue;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 2) {
        tokens.add(token);
        continue;
      }
      for (let index = 0; index < token.length - 1; index++) {
        tokens.add(token.slice(index, index + 2));
      }
      continue;
    }
    if (token.length >= 2) {
      tokens.add(token);
    }
  }

  return tokens;
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizedFindingText(finding: PendingFinding): string {
  return `${finding.title}\n${finding.detail}\n${finding.evidence}\n${finding.suggestion}`.toLowerCase();
}

function hasLocalDeleteWithoutPersistenceSignal(text: string): boolean {
  return (
    text.includes('删除') &&
    (text.includes('splice') || text.includes('本地')) &&
    (text.includes('持久化') ||
      text.includes('后端') ||
      text.includes('接口') ||
      text.includes('delete'))
  );
}

function hasSortedIndexDeletionSignal(text: string): boolean {
  return (
    (text.includes('排序') || text.includes('sortedslices')) &&
    (text.includes('索引') || text.includes('$index') || text.includes('删错'))
  );
}

function haveSameRootCauseSignal(left: PendingFinding, right: PendingFinding): boolean {
  const leftText = normalizedFindingText(left);
  const rightText = normalizedFindingText(right);

  return (
    (hasLocalDeleteWithoutPersistenceSignal(leftText) &&
      hasLocalDeleteWithoutPersistenceSignal(rightText)) ||
    (hasSortedIndexDeletionSignal(leftText) && hasSortedIndexDeletionSignal(rightText))
  );
}

function areDuplicateFindings(left: PendingFinding, right: PendingFinding): boolean {
  if (left.path !== right.path) {
    return false;
  }

  const similarity = tokenSimilarity(tokenizeFindingText(left), tokenizeFindingText(right));
  const lineDistance = Math.abs(left.line - right.line);
  if (haveSameRootCauseSignal(left, right) && (lineDistance <= 80 || similarity >= 0.2)) {
    return true;
  }

  if (similarity >= 0.42) {
    return true;
  }

  return lineDistance <= 80 && similarity >= 0.28;
}

export function dedupeFindingsForReview(findings: PendingFinding[]): PendingFinding[] {
  const deduped: PendingFinding[] = [];

  for (const finding of findings) {
    const duplicateIndex = deduped.findIndex((existing) => areDuplicateFindings(existing, finding));
    if (duplicateIndex === -1) {
      deduped.push(finding);
      continue;
    }

    const existing = deduped[duplicateIndex];
    if (findingWeight(finding) > findingWeight(existing)) {
      deduped[duplicateIndex] = finding;
    }
  }

  return deduped.sort((a, b) => findingWeight(b) - findingWeight(a));
}

const SUMMARY_SECTION_TITLE: Record<string, string> = {
  high: '必须优先处理',
  medium: '建议处理',
  low: '可选优化',
};

function formatCount(count: number, label: string): string | null {
  return count > 0 ? `${count} 个${label}` : null;
}

function formatFindingForSummary(finding: PendingFinding, index: number): string[] {
  const lines = [
    `${index}. **${finding.title}**`,
    `   - 位置：\`${finding.path}:${finding.line}\``,
  ];
  if (finding.detail) {
    lines.push(`   - 影响：${finding.detail}`);
  }
  if (finding.suggestion) {
    lines.push(`   - 建议：${finding.suggestion}`);
  }
  lines.push(`   - 类型：${getCategoryLabel(finding.category)}`);
  return lines;
}

function buildStructuredSummary(
  findings: PendingFinding[],
  total: number,
  high: number,
  medium: number,
  low: number
): string {
  if (total === 0) {
    return [
      '未发现需要立即处理的问题。',
      '',
      '建议人工重点复核：',
      '- 核心业务流程是否符合预期',
      '- 新增接口是否覆盖失败分支',
      '- UI 状态是否与后端数据保持一致',
    ].join('\n');
  }

  const countSummary = [
    formatCount(high, '必须优先处理'),
    formatCount(medium, '建议处理'),
    formatCount(low, '可选优化'),
  ]
    .filter((item): item is string => Boolean(item))
    .join('、');

  const lines: string[] = [
    `发现 ${total} 个需要关注的问题：${countSummary}。`,
    '',
    '行级评论已标在对应代码位置；下面按处理优先级汇总。',
    '',
  ];

  for (const severity of ['high', 'medium', 'low'] as const) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push(`### ${SUMMARY_SECTION_TITLE[severity]}`);
    lines.push('');
    for (const [index, finding] of group.entries()) {
      lines.push(...formatFindingForSummary(finding, index + 1));
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

export class ReviewKernelRuntime {
  private readonly runner: AgentKernelRunner<ReviewKernelState>;
  private readonly skillRegistry = new KernelTaskRegistry<ReviewKernelState>();
  private readonly agentRegistry = new KernelAgentRegistry<ReviewKernelState>();
  private readonly hookRegistry = new KernelHookRegistry();
  private readonly agentInvoker = new KernelAgentInvoker(this.agentRegistry, this.hookRegistry);
  private readonly toolRegistry = new ToolRegistry();
  private readonly compressionService = new ContextCompressionService(llmGateway);

  constructor(
    private readonly store: FileReviewStore,
    private readonly localRepoManager: LocalRepoManager,
    private readonly diffExtractor: DiffExtractor
  ) {
    this.toolRegistry.register(createCodeSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFunctionReferenceSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFileReadTool());

    this.registerHandlers();
    this.registerHooks();
    this.runner = new AgentKernelRunner(
      this.skillRegistry,
      this.agentInvoker,
      this.createPlanner()
    );

    for (const agent of createReviewBuiltInSubagents({
      store: this.store,
      toolRegistry: this.toolRegistry,
      hookRegistry: this.hookRegistry,
      requireRun: (runId) => this.requireRun(runId),
    })) {
      this.agentRegistry.register(agent);
    }
  }

  async execute(run: ReviewRun, sessionId: string): Promise<KernelCheckpoint<ReviewKernelState>> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) {
      await this.store.markRunIgnored(run.id, '缺少目标 sha');
      return {
        state: {
          reviewCompleted: false,
          reviewHints: [],
          findings: [],
          published: false,
          reviewedRefSaved: false,
          compressedContext: undefined,
        },
        pendingTasks: [],
        stopReason: 'missing_target_sha',
      };
    }

    kernelSessionRepository.appendEvent(sessionId, 'run_started', {
      runId: run.id,
      eventType: run.eventType,
      targetSha,
    });

    await runKernelHooks({
      registry: this.hookRegistry,
      input: {
        event: 'SessionStart',
        sessionId,
        runId: run.id,
        scopeKey: `${run.owner}/${run.repo}${run.prNumber ? `#${run.prNumber}` : `@${targetSha}`}`,
      },
    });

    try {
      // execute() always represents a new review run. A PR session is intentionally reused across
      // commits/attempts, but a completed checkpoint from an older run must not short-circuit the
      // new run. Continuation uses continueExecution(); new webhook-triggered runs start fresh.
      kernelSessionRepository.deleteCheckpoint(sessionId);

      const checkpoint = await this.runner.run({
        sessionId,
        runId: run.id,
        initialState: {
          targetSha,
          reviewCompleted: false,
          reviewHints: [],
          findings: [],
          published: false,
          reviewedRefSaved: false,
          compressedContext: undefined,
        },
        initialTasks: [],
      });

      if (checkpoint.stopReason === 'empty_diff') {
        return checkpoint;
      }

      kernelSessionRepository.appendEvent(sessionId, 'run_completed', {
        runId: run.id,
        stopReason: checkpoint.stopReason,
        findings: checkpoint.state.findings.length,
      });
      return checkpoint;
    } finally {
      const latest = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(sessionId);
      if (latest?.state.mirrorPath && latest.state.workspacePath) {
        await this.localRepoManager.cleanupWorkspace({
          mirrorPath: latest.state.mirrorPath,
          workspacePath: latest.state.workspacePath,
        });
      }
    }
  }

  async continueExecution(
    run: ReviewRun,
    sessionId: string
  ): Promise<KernelCheckpoint<ReviewKernelState>> {
    return this.runner.run({
      sessionId,
      runId: run.id,
      initialState: {
        targetSha: run.headSha || run.commitSha,
        reviewCompleted: false,
        reviewHints: [],
        findings: [],
        published: false,
        reviewedRefSaved: false,
        compressedContext: undefined,
      },
      initialTasks: [],
      continueExisting: true,
    });
  }

  listTaskCatalog(): KernelTaskDefinition[] {
    return [...this.skillRegistry.getAll(), ...this.agentInvoker.getAll()].map((handler) => ({
      kind: handler.kind,
      name: handler.name,
      description: handler.description,
      resumable: handler.resumable,
    }));
  }

  listSubagentCatalog() {
    return this.agentInvoker.getAll().map((agent) => ({
      kind: agent.kind,
      name: agent.name,
      source: agent.source,
      description: agent.description,
      whenToUse: agent.whenToUse,
      modelRole: agent.modelRole,
      tags: agent.tags ?? [],
      resumable: agent.resumable,
    }));
  }

  listHookCatalog() {
    return this.hookRegistry.getAll().map((hook) => ({
      name: hook.name,
      event: hook.event,
      description: hook.description,
    }));
  }

  private registerHandlers(): void {
    this.skillRegistry.register(this.createPrepareWorkspaceSkill());
    this.skillRegistry.register(this.createBuildContextSkill());
    this.skillRegistry.register(this.createCompressContextSkill());
    this.skillRegistry.register(this.createAggregateFindingsSkill());
    this.skillRegistry.register(this.createPublishSkill());
    this.skillRegistry.register(this.createSaveReviewedRefSkill());
  }

  private registerHooks(): void {
    this.hookRegistry.register({
      name: 'kernel:session-start-audit',
      event: 'SessionStart',
      description: '记录 session 启动附加上下文',
      execute: async (input) => {
        if (input.event !== 'SessionStart') {
          return;
        }
        kernelSessionRepository.appendEvent(input.sessionId, 'hook_session_start', {
          runId: input.runId,
          scopeKey: input.scopeKey,
        });
        return {
          additionalContext: `Session started for ${input.scopeKey}`,
        };
      },
    });

    this.hookRegistry.register({
      name: 'kernel:subagent-start-audit',
      event: 'SubagentStart',
      description: '记录 subagent 启动元数据',
      execute: async (input) => {
        if (input.event !== 'SubagentStart') {
          return;
        }
        kernelSessionRepository.appendEvent(input.sessionId, 'hook_subagent_start', {
          runId: input.runId,
          subagentName: input.subagentName,
          agentId: input.agentId,
        });
        return {
          additionalContext: `Subagent ${input.subagentName} started`,
        };
      },
    });

    this.hookRegistry.register({
      name: 'kernel:pre-tool-audit',
      event: 'PreToolUse',
      description: '记录工具调用前的附加上下文',
      execute: async (input) => {
        if (input.event !== 'PreToolUse') {
          return;
        }
        return {
          additionalContext: `Preparing tool ${input.toolName}`,
        };
      },
    });

    this.hookRegistry.register({
      name: 'kernel:permission-request-audit',
      event: 'PermissionRequest',
      description: '记录工具权限请求事件',
      execute: async (input) => {
        if (input.event !== 'PermissionRequest') {
          return;
        }
        return {
          additionalContext: `Permission ${input.suggestedBehavior} for ${input.toolName}`,
        };
      },
    });
  }

  private createPlanner(): KernelTurnPlanner<ReviewKernelState> {
    return {
      plan: (context) => this.planTasks(context),
    };
  }

  private planTasks(context: KernelPlanningContext<ReviewKernelState>): KernelTask[] {
    if (context.pendingTasks.length > 0) {
      return [];
    }

    if (!context.state.mirrorPath || !context.state.workspacePath) {
      return [{ kind: 'skill', name: 'prepare_workspace' }];
    }

    if (!context.state.context) {
      return [{ kind: 'skill', name: 'build_context' }];
    }

    if (
      this.compressionService.shouldCompress(context.state.context, context.state.compressedContext)
    ) {
      return [{ kind: 'skill', name: 'compress_context' }];
    }

    if (!context.state.triage && !context.state.reviewTask) {
      return [{ kind: 'subagent', name: this.requireSubagentByTag('triage') }];
    }

    if (!context.state.reviewCompleted) {
      return [
        {
          kind: 'subagent',
          name: REVIEW_FULL_REVIEW_SUBAGENT,
        },
      ];
    }

    if (!context.state.decision) {
      return [{ kind: 'skill', name: 'aggregate_findings' }];
    }

    if (!context.state.published) {
      return [{ kind: 'skill', name: 'publish_review' }];
    }

    if (!context.state.reviewedRefSaved) {
      return [{ kind: 'skill', name: 'save_reviewed_ref' }];
    }

    return [];
  }

  private createCompressContextSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'compress_context',
      description: '在上下文接近窗口上限时生成可恢复摘要',
      resumable: true,
      execute: async (_task, context) => {
        if (!context.state.context) {
          throw new Error('缺少可压缩上下文');
        }

        const compressedContext = await this.compressionService.compress(
          context.state.context,
          context.state.projectPrompt
        );

        return {
          state: {
            ...context.state,
            compressedContext,
          },
        };
      },
    };
  }

  private requireSubagentByTag(tag: string): string {
    const agent = this.agentInvoker.filterByTag(tag)[0];
    if (!agent) {
      throw new Error(`Kernel subagent with tag '${tag}' not registered`);
    }
    return agent.name;
  }

  private createPrepareWorkspaceSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'prepare_workspace',
      description: '准备本地 mirror 与 workspace',
      resumable: true,
      execute: async (_task, context) => {
        const run = await this.requireRun(context.runId);
        const targetSha = run.headSha || run.commitSha;
        if (!targetSha) {
          throw new Error('缺少目标 sha');
        }

        const startedAt = new Date().toISOString();
        await this.store.addStep({
          runId: run.id,
          stepName: 'kernel_prepare_workspace',
          status: 'started',
          startedAt,
        });

        const repoPaths = await this.localRepoManager.prepareWorkspace(
          run.owner,
          run.repo,
          run.cloneUrl,
          targetSha,
          run.id,
          run.headCloneUrl
        );

        let lastReviewedHead: string | undefined;
        if (run.eventType === 'pull_request' && run.prNumber) {
          const snapshot = await this.localRepoManager.resolveReviewedRef(
            repoPaths.mirrorPath,
            run.prNumber
          );
          if (snapshot && snapshot.baseSha === run.baseSha) {
            lastReviewedHead = snapshot.headSha;
          }
        }

        await this.store.addStep({
          runId: run.id,
          stepName: 'kernel_prepare_workspace',
          status: 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - new Date(startedAt).getTime(),
        });

        return {
          state: {
            ...context.state,
            targetSha,
            mirrorPath: repoPaths.mirrorPath,
            workspacePath: repoPaths.workspacePath,
            lastReviewedHead,
          },
        };
      },
    };
  }

  private createBuildContextSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'build_context',
      description: '构建 diff、文件内容与项目提示上下文',
      resumable: true,
      execute: async (_task, context) => {
        const run = await this.requireRun(context.runId);
        if (!context.state.mirrorPath || !context.state.workspacePath) {
          throw new Error('缺少工作空间状态');
        }

        const startedAt = new Date().toISOString();
        await this.store.addStep({
          runId: run.id,
          stepName: 'kernel_build_context',
          status: 'started',
          startedAt,
        });

        const reviewContext = await this.diffExtractor.buildContext(
          run,
          context.state.mirrorPath,
          context.state.workspacePath,
          context.state.lastReviewedHead
        );
        const projectPrompt = resolveProjectReviewPrompt(run.owner, run.repo);

        await this.store.addStep({
          runId: run.id,
          stepName: 'kernel_build_context',
          status: 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - new Date(startedAt).getTime(),
        });

        if (!reviewContext.diff.trim()) {
          await this.publishSummary(run, '本次变更无可审查差异内容，已跳过自动行级评论。', 0);
          await this.store.markRunIgnored(run.id, '无可审查差异');
          return {
            state: {
              ...context.state,
              context: reviewContext,
              projectPrompt,
            },
            stopReason: 'empty_diff',
          };
        }

        return {
          state: {
            ...context.state,
            context: reviewContext,
            projectPrompt,
          },
        };
      },
    };
  }

  private createAggregateFindingsSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'aggregate_findings',
      description: '聚合 findings：去重、排序、应用发布策略',
      resumable: true,
      execute: async (_task, context) => {
        const run = await this.requireRun(context.runId);
        const bestByFingerprint = new Map<string, PendingFinding>();
        for (const finding of context.state.findings) {
          const existing = bestByFingerprint.get(finding.fingerprint);
          if (!existing) {
            bestByFingerprint.set(finding.fingerprint, finding);
            continue;
          }

          if (findingWeight(finding) > findingWeight(existing)) {
            bestByFingerprint.set(finding.fingerprint, finding);
          }
        }

        const dedupedFindings = dedupeFindingsForReview([...bestByFingerprint.values()]);

        const total = dedupedFindings.length;
        const high = dedupedFindings.filter((finding) => finding.severity === 'high').length;
        const medium = dedupedFindings.filter((finding) => finding.severity === 'medium').length;
        const low = dedupedFindings.filter((finding) => finding.severity === 'low').length;
        const summaryMarkdown = buildStructuredSummary(dedupedFindings, total, high, medium, low);
        const decision = { summaryMarkdown, findings: dedupedFindings };

        const policyResult = {
          publishable: decision.findings.filter(
            (finding) => finding.severity === 'high' || finding.severity === 'medium'
          ),
          gated: [],
          dropped: decision.findings.filter((finding) => finding.severity === 'low'),
        };

        const runDetails = await this.store.getRunDetails(run.id);
        const publishedStatus = new Map<string, boolean>();
        for (const finding of runDetails?.findings ?? []) {
          publishedStatus.set(finding.fingerprint, finding.published);
        }

        const persistedFindings = [...policyResult.publishable, ...policyResult.gated].map(
          (finding) => ({
            ...finding,
            id: randomUUID(),
            runId: run.id,
            published: publishedStatus.get(finding.fingerprint) || false,
          })
        );
        await this.store.addFindings(run.id, persistedFindings);

        return {
          state: {
            ...context.state,
            decision,
            policyResult,
          },
        };
      },
    };
  }

  private createPublishSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'publish_review',
      description: '发布 summary、line comments 与人工 gate 记录',
      resumable: true,
      execute: async (_task, context) => {
        const run = await this.requireRun(context.runId);
        const { decision, policyResult } = context.state;
        if (!decision || !policyResult) {
          throw new Error('缺少发布阶段所需状态');
        }

        const runDetails = await this.store.getRunDetails(run.id);
        const summaryPublished =
          runDetails?.comments.some((comment) => comment.status === 'published' && !comment.path) ||
          false;
        const lineCommentsPublished =
          runDetails?.comments.some(
            (comment) => comment.status === 'published' && !!comment.path
          ) || false;

        if (!lineCommentsPublished) {
          const publishableForLineComments = policyResult.publishable.filter(
            (finding) => finding.severity !== 'low'
          );
          const lineComments = publishableForLineComments.map(findingToLineComment);
          const published = await this.publishLineComments(run, lineComments);
          if (published) {
            for (const finding of policyResult.publishable) {
              await this.store.markFindingPublished(run.id, finding.fingerprint);
            }
          }
        } else {
          for (const finding of policyResult.publishable) {
            await this.store.markFindingPublished(run.id, finding.fingerprint);
          }
        }

        if (!summaryPublished) {
          await this.publishSummary(run, decision.summaryMarkdown, policyResult.gated.length);
        }

        const existingPending =
          runDetails?.comments.filter((comment) => comment.status === 'pending') || [];
        const addedLocations = new Set<string>();
        for (const finding of policyResult.gated) {
          const locationKey = `${finding.path}:${finding.line}`;
          const alreadyPending =
            existingPending.some(
              (comment) => comment.path === finding.path && comment.line === finding.line
            ) || addedLocations.has(locationKey);
          if (alreadyPending) {
            continue;
          }

          await this.store.addCommentRecord({
            runId: run.id,
            status: 'pending',
            body: `PENDING: ${finding.title}`,
            path: finding.path,
            line: finding.line,
            fingerprint: finding.fingerprint,
          });
          addedLocations.add(locationKey);
        }

        return {
          state: {
            ...context.state,
            published: true,
          },
          stopReason: policyResult.gated.length > 0 ? 'awaiting_human_feedback' : undefined,
        };
      },
    };
  }

  private createSaveReviewedRefSkill(): KernelTaskHandler<ReviewKernelState> {
    return {
      kind: 'skill',
      name: 'save_reviewed_ref',
      description: '保存 PR 审查快照 ref，支持后续增量审查',
      resumable: true,
      execute: async (_task, context) => {
        const run = await this.requireRun(context.runId);
        if (
          run.eventType !== 'pull_request' ||
          !run.prNumber ||
          !run.baseSha ||
          !context.state.targetSha ||
          !context.state.mirrorPath
        ) {
          return {
            state: {
              ...context.state,
              reviewedRefSaved: true,
            },
          };
        }

        await this.localRepoManager.saveReviewedRef(
          context.state.mirrorPath,
          run.prNumber,
          run.baseSha,
          context.state.targetSha
        );

        return {
          state: {
            ...context.state,
            reviewedRefSaved: true,
          },
        };
      },
    };
  }

  private async publishSummary(run: ReviewRun, summary: string, gatedCount: number): Promise<void> {
    const body = `## AI 代码审查结果\n\n${summary}${summarizeGatedCount(gatedCount)}`;

    if (run.eventType === 'pull_request' && run.prNumber) {
      await giteaService.addPullRequestComment(run.owner, run.repo, run.prNumber, body);
    } else if (run.commitSha) {
      await giteaService.addCommitComment(run.owner, run.repo, run.commitSha, body);
    } else {
      return undefined;
    }

    await this.store.addCommentRecord({
      runId: run.id,
      status: 'published',
      body,
    });
  }

  private async publishLineComments(
    run: ReviewRun,
    comments: LineCommentInput[]
  ): Promise<boolean> {
    if (comments.length === 0) {
      return false;
    }

    const commitId = run.commitSha || run.headSha;
    if (!commitId) {
      return false;
    }

    let prNumber = run.prNumber || run.relatedPrNumber;
    if (!prNumber) {
      const related = await giteaService.getRelatedPullRequest(run.owner, run.repo, commitId);
      prNumber = related?.number;
    }
    if (!prNumber) {
      return false;
    }

    await giteaService.addLineComments(run.owner, run.repo, prNumber, commitId, comments);
    for (const comment of comments) {
      await this.store.addCommentRecord({
        runId: run.id,
        status: 'published',
        path: comment.path,
        line: comment.line,
        body: comment.comment,
      });
    }
    return true;
  }

  private async requireRun(runId: string): Promise<ReviewRun> {
    const details = await this.store.getRunDetails(runId);
    if (!details) {
      throw new Error(`Review run not found: ${runId}`);
    }
    return details.run;
  }
}
