import { KernelAgentInvoker } from '../agents/kernel-agent-invoker';
import { KernelTaskRegistry } from '../registry/kernel-task-registry';
import { kernelSessionRepository } from '../session/session-repository';
import type {
  KernelCheckpoint,
  KernelExecutionContext,
  KernelTask,
  KernelTurnPlanner,
} from '../types';

export class AgentKernelRunner<TState> {
  constructor(
    private readonly skillRegistry: KernelTaskRegistry<TState>,
    private readonly subagentInvoker: KernelAgentInvoker<TState>,
    private readonly planner: KernelTurnPlanner<TState>
  ) {}

  async run(params: {
    sessionId: string;
    runId: string;
    initialState: TState;
    initialTasks: KernelTask[];
    continueExisting?: boolean;
  }): Promise<KernelCheckpoint<TState>> {
    const session = kernelSessionRepository.getSessionById(params.sessionId);
    if (!session) {
      throw new Error(`Kernel session not found: ${params.sessionId}`);
    }

    const persisted = kernelSessionRepository.loadCheckpoint<TState>(params.sessionId);
    let state = persisted?.state ?? params.initialState;
    const pendingTasks = [...(persisted?.pendingTasks ?? params.initialTasks)];
    let stopReason: string | undefined;

    while (!stopReason) {
      if (pendingTasks.length === 0) {
        const plannedTasks = this.planner.plan({
          session,
          runId: params.runId,
          state,
          pendingTasks: [...pendingTasks],
        });

        if (plannedTasks.length === 0) {
          stopReason = 'completed';
          break;
        }

        pendingTasks.push(...plannedTasks);
      }

      const task = pendingTasks.shift() as KernelTask;
      if (task.kind === 'subagent' && !this.subagentInvoker.get(task.name)) {
        throw new Error(`Kernel subagent handler not found: ${task.name}`);
      }
      if (task.kind === 'skill' && !this.skillRegistry.get(task.name)) {
        throw new Error(`Kernel skill handler not found: ${task.name}`);
      }

      kernelSessionRepository.appendEvent(params.sessionId, 'task_started', {
        kind: task.kind,
        name: task.name,
        input: task.input ?? {},
        runId: params.runId,
      });

      const context: KernelExecutionContext<TState> = {
        session,
        runId: params.runId,
        state,
      };
      let result;
      let invocation;
      try {
        if (task.kind === 'skill') {
          result = await this.skillRegistry.get(task.name)?.execute(task, context);
        } else {
          const invocationOutput = await this.subagentInvoker.invoke(task, context);
          result = invocationOutput.result;
          invocation = invocationOutput.invocation;
        }
      } catch (error) {
        kernelSessionRepository.appendEvent(params.sessionId, 'task_failed', {
          kind: task.kind,
          name: task.name,
          runId: params.runId,
          invocationId: invocation?.id,
          agentId: invocation?.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        kernelSessionRepository.saveCheckpoint(params.sessionId, {
          state,
          pendingTasks: [task, ...pendingTasks],
          stopReason: 'failed',
        });
        throw error;
      }

      if (result?.state !== undefined) {
        state = result.state;
      }
      if (result?.prepend?.length) {
        pendingTasks.unshift(...result.prepend);
      }
      if (result?.enqueue?.length) {
        pendingTasks.push(...result.enqueue);
      }
      if (result?.stopReason) {
        stopReason = result.stopReason;
      }

      kernelSessionRepository.appendEvent(params.sessionId, 'task_completed', {
        kind: task.kind,
        name: task.name,
        runId: params.runId,
        invocationId: invocation?.id,
        agentId: invocation?.agentId,
        summary: invocation?.result?.summary ?? result?.summary,
        artifacts: invocation?.result?.artifacts ?? result?.artifacts,
        stopReason: result?.stopReason,
      });

      kernelSessionRepository.saveCheckpoint(params.sessionId, {
        state,
        pendingTasks,
        stopReason,
      });
    }

    const checkpoint = {
      state,
      pendingTasks,
      stopReason: stopReason ?? 'completed',
    };
    kernelSessionRepository.saveCheckpoint(params.sessionId, checkpoint);
    return checkpoint;
  }
}
