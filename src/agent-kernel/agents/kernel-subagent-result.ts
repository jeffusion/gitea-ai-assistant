import type { KernelHandlerResult, KernelSubagentInvocationResult } from '../types';

export function finalizeKernelSubagentResult<TState>(params: {
  agentId: string;
  agentType: string;
  startTime: number;
  result?: KernelHandlerResult<TState>;
}): KernelSubagentInvocationResult {
  const { agentId, agentType, startTime, result } = params;
  const totalDurationMs = Date.now() - startTime;

  return {
    agentId,
    agentType,
    summary: result?.summary ?? `${agentType} completed`,
    totalDurationMs,
    totalToolUseCount: 0,
    totalTokens: 0,
    artifacts: result?.artifacts,
  };
}
