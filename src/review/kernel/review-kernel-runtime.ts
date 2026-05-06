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
import config from '../../config';
import { llmGateway } from '../../llm/gateway';
import { giteaService } from '../../services/gitea';
import { logger } from '../../utils/logger';
import { DiffExtractor } from '../context/diff-extractor';
import type { LocalRepoManager } from '../context/local-repo-manager';
import { LearningSystem } from '../learning/learning-system';
import { VectorMemoryStore } from '../memory/vector-store';
import { applyPublishPolicy } from '../policy/publish-policy';
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

interface LineCommentInput {
  path: string;
  line: number;
  comment: string;
}

function summarizeGatedCount(gatedCount: number): string {
  if (gatedCount <= 0) {
    return '';
  }
  return `\n\n> ${gatedCount} 条低置信或低优先级问题已进入人工审批队列。`;
}

function findingToLineComment(finding: PendingFinding): LineCommentInput {
  return {
    path: finding.path,
    line: finding.line,
    comment: `**[${finding.severity.toUpperCase()}][${finding.category}]** ${finding.title}\n\n${finding.detail}\n\n建议: ${finding.suggestion}`,
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

const SEVERITY_ICON: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🔵',
};

function buildStructuredSummary(
  findings: PendingFinding[],
  total: number,
  high: number,
  medium: number,
  low: number
): string {
  if (total === 0) {
    return '本次变更未发现需要立即处理的高置信问题。建议人工快速复核关键业务路径。';
  }

  const lines: string[] = [
    `本次 AI Agent 审查共识别 ${total} 个问题，其中 high ${high} 个、medium ${medium} 个、low ${low} 个。`,
    '',
    '以下评论按风险优先级自动发布，建议优先处理 high 与 medium 项。',
    '',
  ];

  for (const finding of findings) {
    const icon = SEVERITY_ICON[finding.severity] ?? '⚪';
    lines.push('---');
    lines.push('');
    lines.push(
      `### ${icon} [${finding.severity.toUpperCase()}] ${finding.title} — \`${finding.path}:${finding.line}\``
    );
    lines.push('');
    if (finding.detail) {
      lines.push(`> ${finding.detail}`);
      lines.push('');
    }
    if (finding.evidence) {
      lines.push(`**证据**: \`${finding.evidence}\``);
      lines.push('');
    }
    if (finding.suggestion) {
      lines.push(`**建议**: ${finding.suggestion}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export class ReviewKernelRuntime {
  private readonly runner: AgentKernelRunner<ReviewKernelState>;
  private readonly skillRegistry = new KernelTaskRegistry<ReviewKernelState>();
  private readonly agentRegistry = new KernelAgentRegistry<ReviewKernelState>();
  private readonly hookRegistry = new KernelHookRegistry();
  private readonly agentInvoker = new KernelAgentInvoker(this.agentRegistry, this.hookRegistry);
  private readonly toolRegistry = new ToolRegistry();
  private readonly compressionService = new ContextCompressionService(llmGateway);
  private readonly memoryStore?: VectorMemoryStore;

  constructor(
    private readonly store: FileReviewStore,
    private readonly localRepoManager: LocalRepoManager,
    private readonly diffExtractor: DiffExtractor
  ) {
    this.toolRegistry.register(createCodeSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFunctionReferenceSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFileReadTool());

    let learningSystem: LearningSystem | undefined;
    if (config.review.qdrantUrl && config.review.enableMemory) {
      this.memoryStore = new VectorMemoryStore(config.review.qdrantUrl);
      learningSystem = new LearningSystem(this.memoryStore, this.store);
      this.memoryStore.initialize().catch((error) => {
        logger.warn('Kernel 向量记忆系统初始化失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

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
      learningSystem,
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
          domainTasks: [],
          completedDomains: [],
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
      const existingCheckpoint =
        kernelSessionRepository.loadCheckpoint<ReviewKernelState>(sessionId);
      if (existingCheckpoint && existingCheckpoint.state.targetSha !== targetSha) {
        kernelSessionRepository.deleteCheckpoint(sessionId);
      }

      const checkpoint = await this.runner.run({
        sessionId,
        runId: run.id,
        initialState: {
          targetSha,
          domainTasks: [],
          completedDomains: [],
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
        domainTasks: [],
        completedDomains: [],
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

    if (!context.state.triage && context.state.domainTasks.length === 0) {
      return [{ kind: 'subagent', name: this.requireSubagentByTag('triage') }];
    }

    const remainingDomains = context.state.domainTasks
      .map((task) => task.domain)
      .filter((domain) => !context.state.completedDomains.includes(domain));
    if (remainingDomains.length > 0) {
      return remainingDomains.map((domain) => ({
        kind: 'subagent',
        name: this.requireDomainSubagent(domain),
      }));
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

  private requireDomainSubagent(domain: string): string {
    const agent = this.agentInvoker
      .filterByTag('domain-review')
      .find((item) => item.tags?.includes(`domain:${domain}`));
    if (!agent) {
      throw new Error(`Kernel domain subagent not registered for '${domain}'`);
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

          const existingWeight = severityWeight(existing) * existing.confidence;
          const currentWeight = severityWeight(finding) * finding.confidence;
          if (currentWeight > existingWeight) {
            bestByFingerprint.set(finding.fingerprint, finding);
          }
        }

        const dedupedFindings = [...bestByFingerprint.values()].sort(
          (a, b) => severityWeight(b) * b.confidence - severityWeight(a) * a.confidence
        );

        const total = dedupedFindings.length;
        const high = dedupedFindings.filter((finding) => finding.severity === 'high').length;
        const medium = dedupedFindings.filter((finding) => finding.severity === 'medium').length;
        const low = dedupedFindings.filter((finding) => finding.severity === 'low').length;
        const summaryMarkdown = buildStructuredSummary(dedupedFindings, total, high, medium, low);
        const decision = { summaryMarkdown, findings: dedupedFindings };

        const policyResult = applyPublishPolicy(
          decision.findings,
          config.review.autoPublishMinConfidence,
          config.review.enableHumanGate
        );

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

        if (this.memoryStore && policyResult.publishable.length > 0) {
          const latestDetails = await this.store.getRunDetails(run.id);
          for (const finding of latestDetails?.findings ?? []) {
            if (!finding.published) {
              continue;
            }
            await this.memoryStore
              .storeFinding(finding, true, run.owner, run.repo)
              .catch((error) => {
                logger.warn('Kernel 存储 finding 到向量记忆失败', {
                  findingId: finding.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
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
    const body = `## AI Agent代码审查结果\n\n${summary}${summarizeGatedCount(gatedCount)}`;

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
