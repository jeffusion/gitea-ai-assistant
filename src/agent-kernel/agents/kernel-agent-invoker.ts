import { randomUUID } from 'node:crypto';
import type { KernelHookRegistry } from '../hooks/kernel-hook-registry';
import { runKernelHooks } from '../hooks/kernel-hook-runner';
import { kernelSessionRepository } from '../session/session-repository';
import type {
  KernelAgentExecutionContext,
  KernelDelegationPacket,
  KernelExecutionContext,
  KernelHandlerResult,
  KernelSubagentDefinition,
  KernelTask,
} from '../types';
import { runWithKernelAgentContext } from './kernel-agent-context';
import { KernelAgentRegistry } from './kernel-agent-registry';
import { finalizeKernelSubagentResult } from './kernel-subagent-result';

export interface KernelSubagentInvocationOutput<TState> {
  result?: KernelHandlerResult<TState>;
  invocation: ReturnType<typeof kernelSessionRepository.listSubagentInvocations>[number];
}

export class KernelAgentInvoker<TState> {
  constructor(
    private readonly registry: KernelAgentRegistry<TState>,
    private readonly hookRegistry?: KernelHookRegistry
  ) {}

  get(name: string): KernelSubagentDefinition<TState> | undefined {
    return this.registry.get(name);
  }

  getAll(): KernelSubagentDefinition<TState>[] {
    return this.registry.getAll();
  }

  filterByTag(tag: string): KernelSubagentDefinition<TState>[] {
    return this.registry.filterByTag(tag);
  }

  async invoke(
    task: KernelTask,
    context: KernelExecutionContext<TState>
  ): Promise<KernelSubagentInvocationOutput<TState>> {
    const agent = this.registry.get(task.name);
    if (!agent) {
      throw new Error(`Kernel subagent definition not found: ${task.name}`);
    }

    const agentId = randomUUID();
    const delegation: KernelDelegationPacket = {
      goal: agent.whenToUse,
      parentTaskName: task.name,
      input: task.input ?? {},
      parentSessionId: context.session.id,
      parentRunId: context.runId,
      contextSummary:
        typeof (context.state as { compressedContext?: { summary?: string } }).compressedContext
          ?.summary === 'string'
          ? (context.state as { compressedContext?: { summary?: string } }).compressedContext
              ?.summary
          : undefined,
    };

    const invocation = kernelSessionRepository.createSubagentInvocation({
      parentSessionId: context.session.id,
      parentRunId: context.runId,
      parentTaskName: task.name,
      subagentName: agent.name,
      agentId,
      packet: delegation,
    });

    const agentContext: KernelAgentExecutionContext<TState> = {
      ...context,
      agent,
      delegation,
    };

    if (this.hookRegistry) {
      const hookResult = await runKernelHooks({
        registry: this.hookRegistry,
        input: {
          event: 'SubagentStart',
          sessionId: context.session.id,
          runId: context.runId,
          subagentName: agent.name,
          agentId,
          packet: delegation,
        },
      });
      if (hookResult.blockingReason) {
        throw new Error(hookResult.blockingReason);
      }
    }

    const startTime = Date.now();
    try {
      const result = await runWithKernelAgentContext(
        {
          agentId,
          parentSessionId: context.session.id,
          agentType: 'subagent',
          subagentName: agent.name,
          source: agent.source,
          invocationKind: 'spawn',
        },
        () => agent.execute(task, agentContext)
      );

      const finalized = finalizeKernelSubagentResult({
        agentId,
        agentType: agent.name,
        startTime,
        result,
      });

      return {
        result,
        invocation: kernelSessionRepository.completeSubagentInvocation(
          invocation.id,
          'completed',
          finalized
        ),
      };
    } catch (error) {
      const finalized = finalizeKernelSubagentResult({
        agentId,
        agentType: agent.name,
        startTime,
        result: {
          summary: error instanceof Error ? error.message : String(error),
          artifacts: { error: error instanceof Error ? error.message : String(error) },
        },
      });

      kernelSessionRepository.completeSubagentInvocation(invocation.id, 'failed', finalized);
      throw error;
    }
  }
}
