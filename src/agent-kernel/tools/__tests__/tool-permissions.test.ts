import { describe, expect, test } from 'bun:test';
import type { MainAgentTool } from '../../loop';
import type { ToolPermissionScope } from '../../loop/types';
import {
  DEFAULT_SCOPE_POLICY,
  evaluateToolPermission,
  resolveAgentTools,
} from '../tool-permissions';

function tool(name: string, scope?: ToolPermissionScope): MainAgentTool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object' },
    },
    permissionScope: scope,
    execute: () => ({ name }),
  };
}

describe('evaluateToolPermission', () => {
  test('allows read scope', () => {
    expect(evaluateToolPermission(tool('read_file', 'read')).behavior).toBe('allow');
  });

  test('denies write scope', () => {
    expect(evaluateToolPermission(tool('write_file', 'write')).behavior).toBe('deny');
  });

  test('denies command scope', () => {
    expect(evaluateToolPermission(tool('run_bash', 'command')).behavior).toBe('deny');
  });

  test('denies network scope', () => {
    expect(evaluateToolPermission(tool('http_request', 'network')).behavior).toBe('deny');
  });

  test('defaults to read scope when unspecified', () => {
    expect(evaluateToolPermission(tool('search_code')).behavior).toBe('allow');
  });
});

describe('resolveAgentTools', () => {
  const readTool = tool('read_file', 'read');
  const writeTool = tool('write_file', 'write');
  const searchTool = tool('search_code', 'read');

  test('includes allowed tool names regardless of scope', () => {
    const resolved = resolveAgentTools({
      availableTools: [writeTool],
      allowedToolNames: ['write_file'],
      disallowedToolNames: [],
    });
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0].definition.name).toBe('write_file');
  });

  test('excludes disallowed tool names regardless of scope', () => {
    const resolved = resolveAgentTools({
      availableTools: [readTool],
      allowedToolNames: ['read_file'],
      disallowedToolNames: ['read_file'],
    });
    expect(resolved.tools).toHaveLength(0);
    expect(resolved.deniedToolNames).toContain('read_file');
  });

  test('filters by scope policy when not in allowed/disallowed lists', () => {
    const resolved = resolveAgentTools({
      availableTools: [readTool, writeTool, searchTool],
      allowedToolNames: [],
      disallowedToolNames: [],
    });
    const names = resolved.tools.map((t) => t.definition.name);
    expect(names).toContain('read_file');
    expect(names).toContain('search_code');
    expect(names).not.toContain('write_file');
  });

  test('reports unknown allowed/disallowed names', () => {
    const resolved = resolveAgentTools({
      availableTools: [readTool],
      allowedToolNames: ['missing_tool'],
      disallowedToolNames: ['ghost_tool'],
    });
    expect(resolved.unknownAllowedToolNames).toContain('missing_tool');
    expect(resolved.unknownDisallowedToolNames).toContain('ghost_tool');
  });
});

describe('DEFAULT_SCOPE_POLICY', () => {
  test('only allows read scope', () => {
    expect(DEFAULT_SCOPE_POLICY.read).toBe('allow');
    expect(DEFAULT_SCOPE_POLICY.write).toBe('deny');
    expect(DEFAULT_SCOPE_POLICY.command).toBe('deny');
    expect(DEFAULT_SCOPE_POLICY.network).toBe('deny');
    expect(DEFAULT_SCOPE_POLICY.git_write).toBe('deny');
    expect(DEFAULT_SCOPE_POLICY.cross_session).toBe('deny');
  });
});
