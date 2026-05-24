import type { KernelHookRegistry } from '../../agent-kernel/hooks/kernel-hook-registry';
import { runKernelHooks } from '../../agent-kernel/hooks/kernel-hook-runner';
import type { LLMToolCall } from '../../llm/types';
import { logger } from '../../utils/logger';
import { ToolRegistry } from './registry';
import { evaluateToolPermission } from './tool-permissions';
import type { ToolExecutionContext, ToolExecutionRecord, ToolResult } from './types';

export interface ToolExecutionBatch {
  isConcurrencySafe: boolean;
  toolCalls: LLMToolCall[];
}

function partitionToolCalls(
  toolCalls: LLMToolCall[],
  registry: ToolRegistry
): ToolExecutionBatch[] {
  return toolCalls.reduce<ToolExecutionBatch[]>((batches, toolCall) => {
    const tool = registry.get(toolCall.name);
    const isConcurrencySafe = tool?.isConcurrencySafe ?? false;
    const last = batches[batches.length - 1];
    if (last && last.isConcurrencySafe === isConcurrencySafe) {
      last.toolCalls.push(toolCall);
      return batches;
    }
    batches.push({ isConcurrencySafe, toolCalls: [toolCall] });
    return batches;
  }, []);
}

async function executeSingleTool(
  registry: ToolRegistry,
  toolCall: LLMToolCall,
  context: ToolExecutionContext,
  hookRegistry?: KernelHookRegistry
): Promise<{ result: ToolResult; record: ToolExecutionRecord }> {
  const tool = registry.get(toolCall.name);
  const startTime = Date.now();

  if (!tool) {
    const durationMs = Date.now() - startTime;
    return {
      result: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        error: `工具 ${toolCall.name} 未找到`,
        durationMs,
        isConcurrencySafe: false,
      },
      record: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        agentName: context.agentName,
        agentId: context.agentId,
        source: context.source,
        success: false,
        durationMs,
        isConcurrencySafe: false,
      },
    };
  }

  try {
    let params = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    const permissionDecision = evaluateToolPermission(tool, context);
    let permissionBehavior = permissionDecision.behavior;

    if (permissionBehavior !== 'allow' && hookRegistry) {
      const permissionHookResult = await runKernelHooks({
        registry: hookRegistry,
        input: {
          event: 'PermissionRequest',
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: params,
          context,
          suggestedBehavior: permissionBehavior,
          reason: permissionDecision.reason,
        },
      });

      if (permissionHookResult.results.some((item) => item.decision === 'approve')) {
        permissionBehavior = 'allow';
      }
      if (permissionHookResult.blockingReason) {
        throw new Error(permissionHookResult.blockingReason);
      }
    }

    if (permissionBehavior !== 'allow') {
      throw new Error(permissionDecision.reason);
    }

    const preHookResult = hookRegistry
      ? await runKernelHooks({
          registry: hookRegistry,
          input: {
            event: 'PreToolUse',
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: params,
            context,
          },
        })
      : undefined;

    if (preHookResult?.blockingReason) {
      throw new Error(preHookResult.blockingReason);
    }
    if (preHookResult?.updatedInput) {
      params = preHookResult.updatedInput;
    }

    const result = await tool.execute(params, context);
    const durationMs = Date.now() - startTime;

    const postHookResult = hookRegistry
      ? await runKernelHooks({
          registry: hookRegistry,
          input: {
            event: 'PostToolUse',
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: params,
            output: result,
            context,
          },
        })
      : undefined;

    logger.info(`工具调用成功: ${toolCall.name}`, {
      runId: context.runId,
      agentName: context.agentName,
      isConcurrencySafe: tool.isConcurrencySafe ?? false,
      durationMs,
    });

    return {
      result: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: true,
        result: postHookResult?.additionalContexts.length
          ? {
              data: result,
              hookContext: postHookResult.additionalContexts,
            }
          : result,
        durationMs,
        isConcurrencySafe: tool.isConcurrencySafe ?? false,
        permissionBehavior,
      },
      record: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        agentName: context.agentName,
        agentId: context.agentId,
        source: context.source,
        success: true,
        durationMs,
        isConcurrencySafe: tool.isConcurrencySafe ?? false,
        permissionBehavior,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    if (hookRegistry) {
      await runKernelHooks({
        registry: hookRegistry,
        input: {
          event: 'PostToolUseFailure',
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: (() => {
            try {
              return JSON.parse(toolCall.arguments) as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
          error: message,
          context,
        },
      });
    }

    logger.error(`工具调用失败: ${toolCall.name}`, {
      runId: context.runId,
      agentName: context.agentName,
      error: message,
      durationMs,
    });

    return {
      result: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        error: message,
        durationMs,
        isConcurrencySafe: tool.isConcurrencySafe ?? false,
        permissionBehavior: evaluateToolPermission(tool, context).behavior,
      },
      record: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        agentName: context.agentName,
        agentId: context.agentId,
        source: context.source,
        success: false,
        durationMs,
        isConcurrencySafe: tool.isConcurrencySafe ?? false,
        permissionBehavior: evaluateToolPermission(tool, context).behavior,
      },
    };
  }
}

export interface ToolOrchestrationResult {
  results: ToolResult[];
  records: ToolExecutionRecord[];
}

export async function runToolOrchestration(params: {
  registry: ToolRegistry;
  toolCalls: LLMToolCall[];
  context: ToolExecutionContext;
  hookRegistry?: KernelHookRegistry;
}): Promise<ToolOrchestrationResult> {
  const { registry, toolCalls, context, hookRegistry } = params;
  const batches = partitionToolCalls(toolCalls, registry);

  const results: ToolResult[] = [];
  const records: ToolExecutionRecord[] = [];

  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      const concurrentResults = await Promise.all(
        batch.toolCalls.map((toolCall) =>
          executeSingleTool(registry, toolCall, context, hookRegistry)
        )
      );
      results.push(...concurrentResults.map((item) => item.result));
      records.push(...concurrentResults.map((item) => item.record));
      continue;
    }

    for (const toolCall of batch.toolCalls) {
      const execution = await executeSingleTool(registry, toolCall, context, hookRegistry);
      results.push(execution.result);
      records.push(execution.record);
    }
  }

  return { results, records };
}
