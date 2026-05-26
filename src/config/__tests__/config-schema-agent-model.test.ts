import { describe, expect, test } from 'bun:test';

import { CONFIG_FIELDS } from '../config-schema';

function findField(envKey: string) {
  const field = CONFIG_FIELDS.find((item) => item.envKey === envKey);
  expect(field).toBeDefined();
  return field!;
}

describe('config-schema agent model fields', () => {
  test('AGENT_MAIN_MODEL exists with expected metadata and default', () => {
    const field = findField('AGENT_MAIN_MODEL');

    expect(field.envKey).toBe('AGENT_MAIN_MODEL');
    expect(field.group).toBe('review');
    expect(field.type).toBe('string');
    expect(field.sensitive).toBe(false);
    expect(field.defaultValue).toBe('gpt-4.1');
  });

  test('AGENT_DEFAULT_SUBAGENT_MODEL exists with expected metadata and default', () => {
    const field = findField('AGENT_DEFAULT_SUBAGENT_MODEL');

    expect(field.envKey).toBe('AGENT_DEFAULT_SUBAGENT_MODEL');
    expect(field.group).toBe('review');
    expect(field.type).toBe('string');
    expect(field.sensitive).toBe(false);
    expect(field.defaultValue).toBe('gpt-4.1-mini');
  });
});
