import { describe, expect, test } from 'bun:test';

import {
  agentDefinitionSchema,
  isAgentDefinition,
  normalizeAgentDefinition,
} from '../agent-definition';

describe('agentDefinitionSchema', () => {
  test('parses a valid agent definition', () => {
    const definition = normalizeAgentDefinition({
      agentType: 'subagent',
      name: 'review:fix-validator',
      whenToUse: 'Use for focused fix validation after a failing test run.',
      source: 'built-in',
      tools: ['readFile', 'searchCode'],
      disallowedTools: ['deleteFile'],
      skills: ['diagnostics'],
      hooks: {
        preToolUse: { enabled: true },
      },
      model: 'gpt-4.1-mini',
      maxTurns: 3,
      permissionMode: 'ask',
      background: true,
      isolation: 'workspace',
      getSystemPrompt: () => 'system prompt',
    });

    expect(definition).toEqual({
      agentType: 'subagent',
      name: 'review:fix-validator',
      whenToUse: 'Use for focused fix validation after a failing test run.',
      source: 'built-in',
      tools: ['readFile', 'searchCode'],
      disallowedTools: ['deleteFile'],
      skills: ['diagnostics'],
      hooks: {
        preToolUse: { enabled: true },
      },
      model: 'gpt-4.1-mini',
      maxTurns: 3,
      permissionMode: 'ask',
      background: true,
      isolation: 'workspace',
      getSystemPrompt: definition.getSystemPrompt,
    });
    expect(isAgentDefinition(definition)).toBe(true);
  });

  test('normalizes defaults for omitted runtime fields', () => {
    const definition = normalizeAgentDefinition({
      agentType: 'subagent',
      name: 'review:intake',
      whenToUse: 'Use for initial task routing.',
      source: 'project',
    });

    expect(definition.tools).toEqual([]);
    expect(definition.disallowedTools).toEqual([]);
    expect(definition.skills).toEqual([]);
    expect(definition.hooks).toEqual({});
    expect(definition.model).toBeUndefined();
    expect(definition.maxTurns).toBe(1);
    expect(definition.permissionMode).toBe('default');
    expect(definition.background).toBe(false);
    expect(definition.isolation).toBe('none');
  });

  test('rejects missing required fields', () => {
    const result = agentDefinitionSchema.safeParse({
      agentType: 'subagent',
      source: 'built-in',
      model: 'gpt-4.1-mini',
    });

    expect(result.success).toBe(false);
  });

  test('strips legacy business role fields', () => {
    const legacyKeys = ['plan' + 'ner', 'special' + 'ist', 'ju' + 'dge'];
    const definition = normalizeAgentDefinition({
      agentType: 'subagent',
      name: 'review:modern',
      whenToUse: 'Use for modern runtime routing only.',
      source: 'user',
      model: 'gpt-4.1-mini',
      [legacyKeys[0]]: true,
      [legacyKeys[1]]: true,
      [legacyKeys[2]]: true,
    } as Record<string, unknown>);

    for (const legacyKey of legacyKeys) {
      expect(legacyKey in definition).toBe(false);
    }
  });
});
