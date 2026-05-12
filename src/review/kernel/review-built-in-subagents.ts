import type { KernelHookRegistry } from '../../agent-kernel/hooks/kernel-hook-registry';
import type { KernelSubagentDefinition } from '../../agent-kernel/types';
import config from '../../config';
import { llmGateway } from '../../llm/gateway';
import { SpecialistAgent } from '../agents/specialist-agent';
import { TriageAgent } from '../agents/triage-agent';
import type { FileReviewStore } from '../store/file-review-store';
import { ToolRegistry } from '../tools/registry';
import type { FindingCategory, ReviewRun, ReviewTask } from '../types';
import type { ReviewKernelState } from './review-kernel-state';
import { REVIEW_TRIAGE_SUBAGENT, getReviewDomainSubagentId } from './review-subagent-ids';

function buildDefaultTasks(state: ReviewKernelState): ReviewTask[] {
  if (!state.context) {
    return [];
  }

  const defaultDomains: FindingCategory[] = ['correctness', 'security', 'quality'];

  return defaultDomains.map((domain) => ({
    domain,
    paths: state.context?.changedFiles.map((file) => file.path) ?? [],
    riskTags: [],
    mode: 'full',
    tokenBudget: config.review.tokenBudgetLarge,
    maxIterations: 2,
    allowTools: true,
  }));
}

function mergeDomainTasks(tasks: ReviewTask[]): ReviewTask[] {
  const byDomain = new Map<ReviewTask['domain'], ReviewTask>();
  for (const task of tasks) {
    const existing = byDomain.get(task.domain);
    if (!existing) {
      byDomain.set(task.domain, { ...task, paths: [...new Set(task.paths)] });
      continue;
    }

    byDomain.set(task.domain, {
      ...existing,
      paths: [...new Set([...existing.paths, ...task.paths])],
      riskTags: [...new Set([...existing.riskTags, ...task.riskTags])],
      maxIterations: Math.max(existing.maxIterations, task.maxIterations),
      tokenBudget: Math.max(existing.tokenBudget, task.tokenBudget),
      allowTools: existing.allowTools || task.allowTools,
      mode: existing.mode === 'full' || task.mode === 'full' ? 'full' : 'light',
    });
  }

  return [...byDomain.values()];
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

  const specialistMap: Record<FindingCategory, SpecialistAgent> = {
    correctness: new SpecialistAgent(
      llmGateway,
      'correctness',
      'Correctness Agent',
      '业务逻辑正确性、边界条件、空值处理和明显bug',
      deps.toolRegistry,
      deps.hookRegistry
    ),
    security: new SpecialistAgent(
      llmGateway,
      'security',
      'Security Agent',
      '注入漏洞、权限绕过、敏感信息泄露、反序列化和输入校验缺失',
      deps.toolRegistry,
      deps.hookRegistry
    ),
    quality: new SpecialistAgent(
      llmGateway,
      'quality',
      'Quality Agent',
      '错误处理、重试策略、幂等性、并发一致性、资源释放、可维护性、复杂度和可测试性',
      deps.toolRegistry,
      deps.hookRegistry
    ),
  };

  const triage: KernelSubagentDefinition<ReviewKernelState> = {
    kind: 'subagent',
    name: REVIEW_TRIAGE_SUBAGENT,
    source: 'built-in',
    description: '根据变更范围决定 review 域与审查模式',
    whenToUse: '当需要根据 diff 规模、风险与上下文规划后续专项审查任务时',
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

      return {
        state: {
          ...context.state,
          triage: triageResult,
          domainTasks: mergeDomainTasks(triageResult?.tasks ?? buildDefaultTasks(context.state)),
        },
      };
    },
  };

  const specialists = (Object.keys(specialistMap) as FindingCategory[]).map(
    (domain): KernelSubagentDefinition<ReviewKernelState> => ({
      kind: 'subagent',
      name: getReviewDomainSubagentId(domain),
      source: 'built-in',
      description: `专项审查 ${domain} 域变更`,
      whenToUse: `当 triage 或 planner 认为 ${domain} 是本轮 PR 的重点风险域时`,
      modelRole: 'specialist',
      tags: ['review', 'specialist', 'domain-review', `domain:${domain}`],
      resumable: true,
      execute: async (_task, context) => {
        const run = await deps.requireRun(context.runId);
        if (!context.state.context) {
          throw new Error('缺少审查上下文');
        }

        const reviewTask = context.state.domainTasks.find((item) => item.domain === domain);
        const agent = specialistMap[domain];
        if (!reviewTask || !agent) {
          throw new Error(`未知的审查域: ${domain}`);
        }

        const startedAt = new Date().toISOString();
        await deps.store.addStep({
          runId: run.id,
          stepName: `kernel_review_${domain}`,
          agentName: agent.constructor.name,
          status: 'started',
          startedAt,
        });

        const reviewOptions = {
          scopePaths: reviewTask.paths,
          allowTools: reviewTask.allowTools,
          maxIterations:
            reviewTask.mode === 'full'
              ? Math.max(reviewTask.maxIterations, 4)
              : Math.max(reviewTask.maxIterations, 2),
          mode: reviewTask.mode,
          maxContextTokens: Math.max(1500, Math.floor(reviewTask.tokenBudget * 0.7)),
          projectPrompt: context.state.projectPrompt,
          contextSummary: context.state.compressedContext?.summary,
        } as const;

        const result = await agent.reviewWithOptions(run, context.state.context, reviewOptions);

        await deps.store.addStep({
          runId: run.id,
          stepName: `kernel_review_${domain}`,
          agentName: agent.constructor.name,
          status: 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - new Date(startedAt).getTime(),
        });

        return {
          summary: `${domain} specialist found ${result.findings.length} findings`,
          artifacts: {
            findingsCount: result.findings.length,
            diagnostics: result.diagnostics,
          },
          state: {
            ...context.state,
            completedDomains: [...new Set([...context.state.completedDomains, domain])],
            findings: [...context.state.findings, ...result.findings],
          },
        };
      },
    })
  );

  return [triage, ...specialists];
}
