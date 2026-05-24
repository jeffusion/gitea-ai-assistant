import { describe, expect, test } from 'bun:test';
import { KernelHookRegistry } from '../kernel-hook-registry';
import { runKernelHooks } from '../kernel-hook-runner';
import type { KernelHookDefinition, KernelHookInput } from '../kernel-hook-types';

const baseContext = {
  workspacePath: '/tmp/workspace',
  mirrorPath: '/tmp/mirror',
  runId: 'run-1',
};

function makeRegistry(hooks: KernelHookDefinition[]): KernelHookRegistry {
  const registry = new KernelHookRegistry();
  for (const hook of hooks) {
    registry.register(hook);
  }
  return registry;
}

function makeHook(
  name: string,
  event: KernelHookInput['event'],
  execute: KernelHookDefinition['execute']
): KernelHookDefinition {
  return {
    name,
    event,
    description: `Test hook ${name}`,
    execute,
  };
}

describe('runKernelHooks', () => {
  test.each([
    [
      'SessionStart',
      {
        event: 'SessionStart',
        sessionId: 'session-1',
        runId: 'run-1',
        scopeKey: 'repo#1',
      },
    ],
    [
      'SubagentStart',
      {
        event: 'SubagentStart',
        sessionId: 'session-1',
        runId: 'run-1',
        subagentName: 'test:subagent',
        agentId: 'agent-1',
        packet: {
          input: { focus: 'test' },
          goal: 'test goal',
          parentTaskName: 'test:task',
          parentSessionId: 'session-1',
          parentRunId: 'run-1',
        },
      },
    ],
    [
      'PermissionRequest',
      {
        event: 'PermissionRequest',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        context: baseContext,
        suggestedBehavior: 'ask',
        reason: 'needs approval',
      },
    ],
    [
      'PreToolUse',
      {
        event: 'PreToolUse',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        context: baseContext,
      },
    ],
    [
      'PostToolUse',
      {
        event: 'PostToolUse',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        output: { ok: true },
        context: baseContext,
      },
    ],
    [
      'PostToolUseFailure',
      {
        event: 'PostToolUseFailure',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        error: 'boom',
        context: baseContext,
      },
    ],
  ] as const)('dispatches %s to matching hooks', async (_label, input) => {
    const executed: string[] = [];
    const registry = makeRegistry([
      makeHook('first', input.event, async () => {
        executed.push('first');
        return { additionalContext: 'ctx-1' };
      }),
    ]);

    const result = await runKernelHooks({ registry, input });

    expect(executed).toEqual(['first']);
    expect(result.results).toHaveLength(1);
    expect(result.additionalContexts).toEqual(['ctx-1']);
  });

  test('aggregates additionalContext values and lets later updatedInput override earlier values', async () => {
    const registry = makeRegistry([
      makeHook('first', 'PreToolUse', async () => ({
        additionalContext: 'ctx-1',
        updatedInput: { value: 'first' },
      })),
      makeHook('second', 'PreToolUse', async () => ({
        additionalContext: 'ctx-2',
        updatedInput: { value: 'second' },
      })),
    ]);

    const result = await runKernelHooks({
      registry,
      input: {
        event: 'PreToolUse',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        context: baseContext,
      },
    });

    expect(result.additionalContexts).toEqual(['ctx-1', 'ctx-2']);
    expect(result.updatedInput).toEqual({ value: 'second' });
    expect(result.results).toHaveLength(2);
  });

  test('propagates blockingReason when a hook returns decision block', async () => {
    const registry = makeRegistry([
      makeHook('before', 'PermissionRequest', async () => ({
        additionalContext: 'ctx-before',
        updatedInput: { value: 'before' },
      })),
      makeHook('blocker', 'PermissionRequest', async () => ({
        decision: 'block',
        reason: 'blocked by policy',
        additionalContext: 'ctx-blocker',
        updatedInput: { value: 'blocked' },
      })),
      makeHook('after', 'PermissionRequest', async () => ({
        additionalContext: 'ctx-after',
        updatedInput: { value: 'after' },
      })),
    ]);

    const result = await runKernelHooks({
      registry,
      input: {
        event: 'PermissionRequest',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        context: baseContext,
        suggestedBehavior: 'ask',
        reason: 'needs approval',
      },
    });

    expect(result.additionalContexts).toEqual(['ctx-before', 'ctx-blocker']);
    expect(result.updatedInput).toEqual({ value: 'blocked' });
    expect(result.blockingReason).toBe('blocked by policy');
    expect(result.results).toHaveLength(2);
  });

  test('preserves approve decisions for PermissionRequest without introducing a blocking reason', async () => {
    const registry = makeRegistry([
      makeHook('approver', 'PermissionRequest', async () => ({
        decision: 'approve',
        reason: 'approved by reviewer',
        additionalContext: 'ctx-approve',
        updatedInput: { value: 'approved' },
      })),
    ]);

    const result = await runKernelHooks({
      registry,
      input: {
        event: 'PermissionRequest',
        toolName: 'write_file',
        toolCallId: 'call-1',
        input: { value: 'raw' },
        context: baseContext,
        suggestedBehavior: 'ask',
        reason: 'needs approval',
      },
    });

    expect(result.additionalContexts).toEqual(['ctx-approve']);
    expect(result.updatedInput).toEqual({ value: 'approved' });
    expect(result.blockingReason).toBeUndefined();
    expect(result.results).toEqual([
      expect.objectContaining({
        decision: 'approve',
        reason: 'approved by reviewer',
      }),
    ]);
  });
});
