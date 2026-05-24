import type { KernelHookRegistry } from '../../agent-kernel/hooks/kernel-hook-registry';
import type { KernelSubagentDefinition } from '../../agent-kernel/types';
import config from '../../config';
import { llmGateway } from '../../llm/gateway';
import { AutonomousReviewAgent } from '../agents/autonomous-review-agent';
import { TriageAgent } from '../agents/triage-agent';
import type { TriageResult } from '../agents/triage-agent';
import type { FileReviewStore } from '../store/file-review-store';
import { ToolRegistry } from '../tools/registry';
import type { ReviewRun, ReviewTask } from '../types';
import type { ReviewKernelState } from './review-kernel-state';
import { REVIEW_FULL_REVIEW_SUBAGENT, REVIEW_TRIAGE_SUBAGENT } from './review-subagent-ids';

function buildDefaultReviewTask(state: ReviewKernelState): ReviewTask | undefined {
  if (!state.context) {
    return undefined;
  }

  return {
    riskTags: [],
    mode: 'full',
    tokenBudget: config.review.tokenBudgetLarge,
    suspectedEntrypoints: state.context.changedFiles.map((file) => file.path),
  };
}

function buildReviewTaskFromTriage(
  triageResult: TriageResult | null,
  state: ReviewKernelState
): ReviewTask | undefined {
  if (!triageResult) {
    return buildDefaultReviewTask(state);
  }

  const fallbackPaths = state.context?.changedFiles.map((file) => file.path) ?? [];
  const suspectedEntrypoints = triageResult.suspectedEntrypoints.length
    ? triageResult.suspectedEntrypoints
    : fallbackPaths;

  return {
    riskTags: triageResult.riskTags,
    mode: triageResult.mode,
    reviewSize: triageResult.reviewSize,
    suspectedEntrypoints,
    tokenBudget: triageResult.budgetHints.tokenBudget,
    maxTurns: triageResult.budgetHints.maxTurns,
    maxToolCalls: triageResult.budgetHints.maxToolCalls,
    maxElapsedMs: triageResult.budgetHints.maxElapsedMs,
  };
}

interface ReviewBuiltInSubagentDeps {
  store: FileReviewStore;
  toolRegistry: ToolRegistry;
  hookRegistry: KernelHookRegistry;
  requireRun(runId: string): Promise<ReviewRun>;
}

export function createReviewBuiltInSubagents(
  deps: ReviewBuiltInSubagentDeps
): KernelSubagentDefinition<ReviewKernelState>[] {
  const triageAgent = new TriageAgent(llmGateway);
  const fullReviewAgent = new AutonomousReviewAgent(
    llmGateway,
    deps.toolRegistry,
    deps.hookRegistry
  );

  const triage: KernelSubagentDefinition<ReviewKernelState> = {
    kind: 'subagent',
    name: REVIEW_TRIAGE_SUBAGENT,
    source: 'built-in',
    description: '根据变更范围生成 full review 的上下文提示与审查模式',
    whenToUse: '当需要根据 diff 规模、风险与上下文规划完整自主审查提示时',
    modelRole: 'planner',
    tags: ['review', 'planner', 'triage'],
    resumable: true,
    execute: async (_task, context) => {
      const run = await deps.requireRun(context.runId);
      if (!context.state.context) {
        throw new Error('缺少审查上下文');
      }

      let triageResult = null;
      const startedAt = new Date().toISOString();
      if (config.review.enableTriage) {
        await deps.store.addStep({
          runId: run.id,
          stepName: 'kernel_triage',
          status: 'started',
          startedAt,
        });

        triageResult = await triageAgent.analyze(context.state.context, {
          projectPrompt: context.state.projectPrompt,
          contextSummary: context.state.compressedContext?.summary,
        });

        await deps.store.addStep({
          runId: run.id,
          stepName: 'kernel_triage',
          status: 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - new Date(startedAt).getTime(),
        });
      }

      const reviewTask = buildReviewTaskFromTriage(triageResult, context.state);

      return {
        state: {
          ...context.state,
          triage: triageResult,
          reviewTask,
          reviewHints: [
            ...context.state.reviewHints,
            {
              source: config.review.enableTriage && triageResult ? 'triage' : 'heuristic',
              message: triageResult?.rationale ?? '使用默认审查计划作为自治审查提示。',
              riskTags: triageResult?.riskTags,
              suspectedEntrypoints: reviewTask?.suspectedEntrypoints,
            },
          ],
        },
      };
    },
  };

  const fullReview: KernelSubagentDefinition<ReviewKernelState> = {
    kind: 'subagent',
    name: REVIEW_FULL_REVIEW_SUBAGENT,
    source: 'built-in',
    description: '自主完成本轮代码审查，不按 domain 拆分派发',
    whenToUse: '当 triage 产出审查提示并完成上下文压缩后，执行完整自主审查',
    modelRole: 'specialist',
    tags: ['review', 'full-review', 'autonomous-review'],
    resumable: true,
    execute: async (_task, context) => {
      const run = await deps.requireRun(context.runId);
      if (!context.state.context) {
        throw new Error('缺少审查上下文');
      }

      const reviewTask = context.state.reviewTask ?? buildDefaultReviewTask(context.state);
      if (!reviewTask) {
        throw new Error('缺少审查任务');
      }

      const startedAt = new Date().toISOString();
      await deps.store.addStep({
        runId: run.id,
        stepName: 'kernel_review_full',
        agentName: fullReviewAgent.constructor.name,
        status: 'started',
        startedAt,
      });

      const result = await fullReviewAgent.reviewWithOptions(
        run,
        context.state.context,
        reviewTask,
        {
          projectPrompt: context.state.projectPrompt,
          contextSummary: context.state.compressedContext?.summary,
        }
      );

      await deps.store.addStep({
        runId: run.id,
        stepName: 'kernel_review_full',
        agentName: fullReviewAgent.constructor.name,
        status: 'succeeded',
        startedAt,
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - new Date(startedAt).getTime(),
      });

      return {
        summary: `full review found ${result.findings.length} findings`,
        artifacts: {
          findingsCount: result.findings.length,
          diagnostics: result.diagnostics,
        },
        state: {
          ...context.state,
          reviewTask,
          reviewCompleted: true,
          reviewDiagnostics: result.diagnostics,
          findings: [...context.state.findings, ...result.findings],
        },
      };
    },
  };

  return [triage, fullReview];
}
