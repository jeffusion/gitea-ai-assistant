import { type AgentDefinition, createAgentRegistry } from '../agent-kernel/definitions';
import {
  type MainAgentModelClient,
  MainAgentRunner,
  type MainAgentTool,
} from '../agent-kernel/loop';
import { type AgentSessionRepository, agentSessionRepository } from '../agent-kernel/session';
import { SubagentRunner } from '../agent-kernel/subagents/subagent-runner';
import { createSpawnSubagentTool } from '../agent-kernel/tools';
import config from '../config';
import { DiffExtractor } from '../review/context/diff-extractor';
import type { LocalRepoPaths } from '../review/context/local-repo-manager';
import { LocalRepoManager } from '../review/context/local-repo-manager';
import { FileReviewStore } from '../review/store/file-review-store';
import type { Finding, ReviewContext, ReviewRun } from '../review/types';
import { logger } from '../utils/logger';
import { applyDeterministicPublishAdapter } from './deterministic-publish-adapter';
import {
  type ReviewToolState,
  type SubmittedReviewFindings,
  createReviewTaskTools,
  normalizeSubmission,
} from './tools';

export interface ReviewAgentRepositoryContext {
  owner: string;
  repo: string;
  cloneUrl: string;
  headCloneUrl?: string;
}

export interface ReviewAgentPullRequestContext {
  prNumber?: number;
  relatedPrNumber?: number;
  baseSha?: string;
  headSha?: string;
  commitSha?: string;
  commitMessage?: string;
}

export interface ReviewAgentRunContext {
  reviewRunId: string;
  sessionScope: string;
  eventType: ReviewRun['eventType'];
  repository: ReviewAgentRepositoryContext;
  pullRequest: ReviewAgentPullRequestContext;
  workspace?: Pick<ReviewContext, 'workspacePath' | 'mirrorPath'>;
  diffSummary?: {
    changedFiles: ReviewContext['changedFiles'];
    diff?: string;
  };
}

export interface ReviewAgentEntrypointResult {
  status: 'submitted' | 'completed_without_submission';
  sessionId: string;
  reviewRunId: string;
  sessionScope: string;
  summaryMarkdown: string;
  findings: Finding[];
  finalText?: string;
}

interface ReviewAgentEntrypointOptions {
  store: FileReviewStore;
  localRepoManager: LocalRepoManager;
  diffExtractor: DiffExtractor;
  modelClient: MainAgentModelClient;
  transcriptRepository?: AgentSessionRepository;
  model?: string;
  runnerFactory?: (tools: MainAgentTool[]) => MainAgentRunner;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildSessionScope(run: ReviewRun): string {
  if (run.prNumber) {
    return `pr:${run.owner}/${run.repo}#${run.prNumber}`;
  }
  if (run.relatedPrNumber) {
    return `pr:${run.owner}/${run.repo}#${run.relatedPrNumber}`;
  }
  return `commit:${run.owner}/${run.repo}@${run.commitSha ?? run.headSha ?? run.id}`;
}

function tryParseFinalSubmission(text?: string): SubmittedReviewFindings | null {
  if (!text) return null;
  try {
    return normalizeSubmission(JSON.parse(text));
  } catch {
    return null;
  }
}

function buildReviewPrompt(context: ReviewAgentRunContext): string {
  const changedFiles = context.diffSummary?.changedFiles ?? [];
  const fileSummary = changedFiles
    .map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`)
    .join('\n');
  const diff = context.diffSummary?.diff?.trim() || '(diff omitted)';

  return [
    'You are the main code review agent for Gitea AI Assistant.',
    'Review only the supplied change context and report actionable correctness, security, reliability, or maintainability findings.',
    'When finished, call submit_review_findings exactly once with summaryMarkdown and findings. If no issues are found, submit an empty findings array.',
    '',
    `Review run: ${context.reviewRunId}`,
    `Session scope: ${context.sessionScope}`,
    `Repository: ${context.repository.owner}/${context.repository.repo}`,
    `Event type: ${context.eventType}`,
    `PR: ${context.pullRequest.prNumber ?? context.pullRequest.relatedPrNumber ?? 'n/a'}`,
    `Base SHA: ${context.pullRequest.baseSha ?? 'n/a'}`,
    `Head SHA: ${context.pullRequest.headSha ?? context.pullRequest.commitSha ?? 'n/a'}`,
    '',
    'Changed files:',
    fileSummary || '- none',
    '',
    'Diff:',
    diff,
  ].join('\n');
}

function defaultSubagentDefinition(): AgentDefinition {
  return {
    agentType: 'general-purpose',
    name: 'General Purpose Review Subagent',
    whenToUse: 'Use for delegated focused code checks from the review main agent.',
    source: 'built-in',
    tools: ['search_code', 'read_file', 'find_references', 'get_file_patch'],
    disallowedTools: [],
    skills: [],
    hooks: {},
    maxTurns: 4,
    permissionMode: 'default',
    background: false,
    isolation: 'none',
    getSystemPrompt: () =>
      'You are a focused code-review subagent. Read only provided context, use tools deterministically, and return concise risk-focused findings summary.',
  };
}

export class ReviewAgentEntrypoint {
  private readonly store: FileReviewStore;
  private readonly localRepoManager: LocalRepoManager;
  private readonly diffExtractor: DiffExtractor;
  private readonly transcriptRepository: AgentSessionRepository;
  private readonly modelClient: MainAgentModelClient;
  private readonly model: string;
  private readonly runnerFactory: (tools: MainAgentTool[]) => MainAgentRunner;

  constructor(options: ReviewAgentEntrypointOptions) {
    this.store = options.store;
    this.localRepoManager = options.localRepoManager;
    this.diffExtractor = options.diffExtractor;
    this.modelClient = options.modelClient;
    this.transcriptRepository = options.transcriptRepository ?? agentSessionRepository;
    this.model = options.model ?? config.review.agentMainModel;
    this.runnerFactory =
      options.runnerFactory ??
      ((tools) =>
        new MainAgentRunner({
          modelClient: this.modelClient,
          transcriptRepository: this.transcriptRepository,
          tools,
        }));
  }

  async execute(run: ReviewRun): Promise<ReviewAgentEntrypointResult> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) throw new Error('缺少 target sha，无法启动主 Agent 审查');

    const workspaceStart = Date.now();
    await this.store.addStep({
      runId: run.id,
      stepName: 'prepare_workspace',
      status: 'started',
      startedAt: new Date(workspaceStart).toISOString(),
    });

    let repoPaths: LocalRepoPaths | null = null;
    try {
      repoPaths = await this.localRepoManager.prepareWorkspace(
        run.owner,
        run.repo,
        run.cloneUrl,
        targetSha,
        run.id,
        run.headCloneUrl
      );
      await this.store.addStep({
        runId: run.id,
        stepName: 'prepare_workspace',
        status: 'succeeded',
        startedAt: new Date(workspaceStart).toISOString(),
        finishedAt: nowIso(),
        latencyMs: Date.now() - workspaceStart,
      });

      const lastReviewedHead = await this.resolveLastReviewedHead(
        run,
        repoPaths.mirrorPath,
        targetSha
      );
      const contextStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'started',
        startedAt: new Date(contextStart).toISOString(),
      });
      const reviewContext = await this.diffExtractor.buildContext(
        run,
        repoPaths.mirrorPath,
        repoPaths.workspacePath,
        lastReviewedHead
      );
      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'succeeded',
        startedAt: new Date(contextStart).toISOString(),
        finishedAt: nowIso(),
        latencyMs: Date.now() - contextStart,
      });

      if (!reviewContext.diff.trim()) {
        await this.store.addCommentRecord({
          runId: run.id,
          body: '本次变更无可审查差异内容，已跳过自动行级评论。',
          status: 'pending',
        });
        await this.store.markRunIgnored(run.id, '无可审查差异');
        return {
          status: 'completed_without_submission',
          sessionId: '',
          reviewRunId: run.id,
          sessionScope: buildSessionScope(run),
          summaryMarkdown: '',
          findings: [],
        };
      }

      const result = await this.runMainAgent(run, reviewContext);
      if (run.eventType === 'pull_request' && run.prNumber && run.baseSha) {
        await this.localRepoManager.saveReviewedRef(
          repoPaths.mirrorPath,
          run.prNumber,
          run.baseSha,
          targetSha
        );
      }
      return result;
    } finally {
      if (repoPaths) {
        await this.localRepoManager.cleanupWorkspace(repoPaths);
      }
    }
  }

  private async resolveLastReviewedHead(
    run: ReviewRun,
    mirrorPath: string,
    targetSha: string
  ): Promise<string | undefined> {
    if (run.eventType !== 'pull_request' || !run.prNumber) return undefined;
    const snapshot = await this.localRepoManager.resolveReviewedRef(mirrorPath, run.prNumber);
    if (!snapshot || snapshot.baseSha !== run.baseSha || snapshot.headSha === targetSha)
      return undefined;
    return snapshot.headSha;
  }

  private async runMainAgent(
    run: ReviewRun,
    reviewContext: ReviewContext
  ): Promise<ReviewAgentEntrypointResult> {
    const sessionScope = buildSessionScope(run);
    const reviewToolState: ReviewToolState = { submittedReview: null };
    const reviewTools = createReviewTaskTools({ reviewContext, state: reviewToolState });
    const subagentRunner = new SubagentRunner({
      modelClient: this.modelClient,
      transcriptRepository: this.transcriptRepository,
      tools: reviewTools,
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({ builtIn: [defaultSubagentDefinition()] }),
      executor: subagentRunner,
      defaultSubagentModel: config.review.agentDefaultSubagentModel,
    });
    const runner = this.runnerFactory([...reviewTools, spawnSubagentTool]);

    const runContext: ReviewAgentRunContext = {
      reviewRunId: run.id,
      sessionScope,
      eventType: run.eventType,
      repository: {
        owner: run.owner,
        repo: run.repo,
        cloneUrl: run.cloneUrl,
        headCloneUrl: run.headCloneUrl,
      },
      pullRequest: {
        prNumber: run.prNumber,
        relatedPrNumber: run.relatedPrNumber,
        baseSha: run.baseSha,
        headSha: run.headSha,
        commitSha: run.commitSha,
        commitMessage: run.commitMessage,
      },
      workspace: {
        workspacePath: reviewContext.workspacePath,
        mirrorPath: reviewContext.mirrorPath,
      },
      diffSummary: {
        changedFiles: reviewContext.changedFiles,
        diff: reviewContext.diff,
      },
    };
    const agentResult = await runner.run({
      agentType: 'review-main-agent',
      model: this.model,
      userMessage: buildReviewPrompt(runContext),
      maxTurns: 8,
      maxToolCalls: 4,
      timeoutMs: config.review.commandTimeoutMs,
      session: {
        agentType: 'review-main-agent',
        metadata: {
          reviewRunId: run.id,
          sessionScope,
          owner: run.owner,
          repo: run.repo,
          prNumber: run.prNumber,
          relatedPrNumber: run.relatedPrNumber,
          eventType: run.eventType,
          baseSha: run.baseSha,
          headSha: run.headSha,
          commitSha: run.commitSha,
        },
      },
    });

    const submitted =
      reviewToolState.submittedReview ?? tryParseFinalSubmission(agentResult.finalText);
    const submission = submitted ?? { summaryMarkdown: agentResult.finalText ?? '', findings: [] };
    const adapted = await applyDeterministicPublishAdapter({
      store: this.store,
      runId: run.id,
      submission,
    });

    logger.info('主 Agent 审查入口完成', {
      runId: run.id,
      sessionId: agentResult.sessionId,
      sessionScope,
      findings: adapted.findings.length,
    });

    return {
      status: submitted ? 'submitted' : 'completed_without_submission',
      sessionId: agentResult.sessionId,
      reviewRunId: run.id,
      sessionScope,
      summaryMarkdown: submission.summaryMarkdown,
      findings: adapted.findings,
      finalText: agentResult.finalText,
    };
  }
}
