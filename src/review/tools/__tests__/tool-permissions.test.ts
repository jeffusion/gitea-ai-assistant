import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { evaluateToolPermission } from '../tool-permissions';
import type { Tool } from '../types';

function makeTool(permissionScope?: Tool['permissionScope']): Tool {
  return {
    name: 'sample_tool',
    description: 'Sample tool',
    parameters: z.object({}),
    permissionScope,
    execute: async () => ({}),
  };
}

describe('evaluateToolPermission', () => {
  const cases: Array<{
    scope: NonNullable<Tool['permissionScope']>;
    behavior: 'allow' | 'ask' | 'deny';
    reason: string;
  }> = [
    {
      scope: 'read',
      behavior: 'allow',
      reason: "Tool 'sample_tool' is allowed for scope 'read'",
    },
    {
      scope: 'write',
      behavior: 'ask',
      reason: "Tool 'sample_tool' requires approval for scope 'write'",
    },
    {
      scope: 'command',
      behavior: 'ask',
      reason: "Tool 'sample_tool' requires approval for scope 'command'",
    },
    {
      scope: 'network',
      behavior: 'deny',
      reason: "Tool 'sample_tool' is denied for scope 'network'",
    },
    {
      scope: 'git_write',
      behavior: 'ask',
      reason: "Tool 'sample_tool' requires approval for scope 'git_write'",
    },
    {
      scope: 'cross_session',
      behavior: 'deny',
      reason: "Tool 'sample_tool' is denied for scope 'cross_session'",
    },
  ];

  for (const { scope, behavior, reason } of cases) {
    test(`maps ${scope} to ${behavior}`, () => {
      const decision = evaluateToolPermission(makeTool(scope), {
        workspacePath: '/tmp/workspace',
        mirrorPath: '/tmp/mirror',
        runId: 'run-1',
      });

      expect(decision).toEqual({
        behavior,
        reason,
      });
    });
  }

  test('falls back to read when permissionScope is missing', () => {
    const decision = evaluateToolPermission(makeTool(undefined), {
      workspacePath: '/tmp/workspace',
      mirrorPath: '/tmp/mirror',
      runId: 'run-1',
    });

    expect(decision).toEqual({
      behavior: 'allow',
      reason: "Tool 'sample_tool' is allowed for scope 'read'",
    });
  });
});
