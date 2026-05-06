import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { KernelHookRegistry } from '../../../agent-kernel/hooks/kernel-hook-registry';
import type { LLMToolCall } from '../../../llm/types';
import { ToolRegistry } from '../registry';
import { runToolOrchestration } from '../tool-orchestration';
import type { Tool } from '../types';

function makeTool(
  name: string,
  options: {
    isConcurrencySafe?: boolean;
    execute: Tool['execute'];
  }
): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: z.object({ value: z.string().optional() }),
    isConcurrencySafe: options.isConcurrencySafe,
    execute: options.execute,
  };
}

function makeCall(id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

describe('runToolOrchestration', () => {
  test('runs concurrency-safe tools in parallel batches and serial tools sequentially', async () => {
    const registry = new ToolRegistry();
    const executionOrder: string[] = [];

    registry.register(
      makeTool('read_file', {
        isConcurrencySafe: true,
        execute: async () => {
          executionOrder.push('read:start');
          await Bun.sleep(30);
          executionOrder.push('read:end');
          return { ok: true };
        },
      })
    );
    registry.register(
      makeTool('search_code', {
        isConcurrencySafe: true,
        execute: async () => {
          executionOrder.push('search:start');
          await Bun.sleep(30);
          executionOrder.push('search:end');
          return { ok: true };
        },
      })
    );
    registry.register(
      makeTool('non_safe_tool', {
        isConcurrencySafe: false,
        execute: async () => {
          executionOrder.push('serial:start');
          await Bun.sleep(1);
          executionOrder.push('serial:end');
          return { ok: true };
        },
      })
    );

    const result = await runToolOrchestration({
      registry,
      toolCalls: [
        makeCall('1', 'read_file'),
        makeCall('2', 'search_code'),
        makeCall('3', 'non_safe_tool'),
      ],
      context: {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-1',
        agentName: 'TestAgent',
        agentId: 'agent-1',
        source: 'react',
      },
    });

    expect(result.results).toHaveLength(3);
    expect(result.records).toHaveLength(3);
    expect(executionOrder.indexOf('serial:start')).toBeGreaterThan(
      executionOrder.indexOf('read:end')
    );
    expect(executionOrder.indexOf('serial:start')).toBeGreaterThan(
      executionOrder.indexOf('search:end')
    );
    expect(result.records.every((record) => record.agentId === 'agent-1')).toBe(true);
  });

  test('returns structured failures for missing or broken tools', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool('broken_tool', {
        execute: async () => {
          throw new Error('boom');
        },
      })
    );

    const result = await runToolOrchestration({
      registry,
      toolCalls: [makeCall('1', 'missing_tool'), makeCall('2', 'broken_tool')],
      context: {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-2',
      },
    });

    expect(result.results[0]).toMatchObject({
      toolCallId: '1',
      toolName: 'missing_tool',
      success: false,
    });
    expect(result.results[1]).toMatchObject({
      toolCallId: '2',
      toolName: 'broken_tool',
      success: false,
      error: 'boom',
    });
  });

  test('runs pre/post hooks and allows input/output enrichment', async () => {
    const registry = new ToolRegistry();
    const hookRegistry = new KernelHookRegistry();

    registry.register(
      makeTool('read_file', {
        isConcurrencySafe: true,
        execute: async (params) => ({ echoed: params.value }),
      })
    );

    hookRegistry.register({
      name: 'test:pre-tool',
      event: 'PreToolUse',
      description: 'Mutate tool input before execution',
      execute: async (input) => {
        if (input.event !== 'PreToolUse') {
          return;
        }
        return {
          updatedInput: { ...input.input, value: 'mutated-by-hook' },
          additionalContext: 'pre-hook-ran',
        };
      },
    });

    hookRegistry.register({
      name: 'test:post-tool',
      event: 'PostToolUse',
      description: 'Attach hook context after execution',
      execute: async () => ({
        additionalContext: 'post-hook-ran',
      }),
    });

    const result = await runToolOrchestration({
      registry,
      hookRegistry,
      toolCalls: [makeCall('1', 'read_file', { value: 'raw' })],
      context: {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-hooks',
      },
    });

    expect(result.results[0]).toMatchObject({
      toolCallId: '1',
      toolName: 'read_file',
      success: true,
    });
    expect(result.results[0]?.result).toEqual({
      data: { echoed: 'mutated-by-hook' },
      hookContext: ['post-hook-ran'],
    });
  });

  test('blocks ask-scoped tools by default and can be approved via permission hook', async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register({
      name: 'write_file',
      description: 'Writes file content',
      parameters: z.object({ value: z.string() }),
      permissionScope: 'write',
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    const denied = await runToolOrchestration({
      registry,
      toolCalls: [makeCall('1', 'write_file', { value: 'x' })],
      context: {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-deny',
      },
    });

    expect(executed).toBe(false);
    expect(denied.results[0]).toMatchObject({
      success: false,
      permissionBehavior: 'ask',
    });

    const hookRegistry = new KernelHookRegistry();
    hookRegistry.register({
      name: 'test:permission-approve',
      event: 'PermissionRequest',
      description: 'Approve write tool for test',
      execute: async () => ({
        decision: 'approve',
        reason: 'approved in test',
      }),
    });

    const allowed = await runToolOrchestration({
      registry,
      hookRegistry,
      toolCalls: [makeCall('2', 'write_file', { value: 'y' })],
      context: {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-allow',
      },
    });

    expect(executed).toBe(true);
    expect(allowed.results[0]).toMatchObject({
      success: true,
      permissionBehavior: 'allow',
    });
  });
});
