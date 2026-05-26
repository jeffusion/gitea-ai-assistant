import { describe, expect, test } from 'bun:test';
import type { MainAgentTool } from '../../loop';
import { resolveAgentTools } from '../tool-permissions';

function tool(name: string): MainAgentTool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object' },
    },
    execute: () => ({ name }),
  };
}

describe('resolveAgentTools', () => {
  const availableTools = [tool('read_file'), tool('write_file'), tool('lookup')];

  test('returns the explicitly allowed subset', () => {
    const resolved = resolveAgentTools({
      availableTools,
      allowedToolNames: ['lookup', 'read_file'],
      disallowedToolNames: [],
    });

    expect(resolved.tools.map((item) => item.definition.name)).toEqual(['read_file', 'lookup']);
    expect(resolved.deniedToolNames).toEqual(['write_file']);
    expect(resolved.unknownAllowedToolNames).toEqual([]);
  });

  test('removes disallowed tools even when they are explicitly allowed', () => {
    const resolved = resolveAgentTools({
      availableTools,
      allowedToolNames: ['read_file', 'write_file'],
      disallowedToolNames: ['write_file'],
    });

    expect(resolved.tools.map((item) => item.definition.name)).toEqual(['read_file']);
    expect(resolved.deniedToolNames).toEqual(['write_file', 'lookup']);
  });

  test('treats an empty allow-list as no tools allowed', () => {
    const resolved = resolveAgentTools({
      availableTools,
      allowedToolNames: [],
      disallowedToolNames: [],
    });

    expect(resolved.tools).toEqual([]);
    expect(resolved.deniedToolNames).toEqual(['read_file', 'write_file', 'lookup']);
  });

  test('reports unknown allow-list names without granting tools', () => {
    const resolved = resolveAgentTools({
      availableTools,
      allowedToolNames: ['lookup', 'missing_tool'],
      disallowedToolNames: ['unknown_deny'],
    });

    expect(resolved.tools.map((item) => item.definition.name)).toEqual(['lookup']);
    expect(resolved.unknownAllowedToolNames).toEqual(['missing_tool']);
    expect(resolved.unknownDisallowedToolNames).toEqual(['unknown_deny']);
  });
});
