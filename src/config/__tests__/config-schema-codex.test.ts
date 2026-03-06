import { describe, expect, test } from 'bun:test';
import { CONFIG_FIELDS } from '../config-schema';

function findField(envKey: string) {
  const field = CONFIG_FIELDS.find((item) => item.envKey === envKey);
  expect(field).toBeDefined();
  return field!;
}

describe('config-schema codex fields', () => {
  test('CODEX_API_URL exists with expected metadata and default', () => {
    const field = findField('CODEX_API_URL');

    expect(field.envKey).toBe('CODEX_API_URL');
    expect(field.group).toBe('review');
    expect(field.type).toBe('url');
    expect(field.sensitive).toBe(false);
    expect(field.defaultValue).toBe('https://api.openai.com/v1');
  });

  test('CODEX_API_KEY is marked sensitive', () => {
    const field = findField('CODEX_API_KEY');

    expect(field.envKey).toBe('CODEX_API_KEY');
    expect(field.group).toBe('review');
    expect(field.type).toBe('string');
    expect(field.sensitive).toBe(true);
    expect(field.defaultValue).toBeUndefined();
  });

  test("CODEX_MODEL default is 'o3'", () => {
    const field = findField('CODEX_MODEL');

    expect(field.envKey).toBe('CODEX_MODEL');
    expect(field.group).toBe('review');
    expect(field.type).toBe('string');
    expect(field.sensitive).toBe(false);
    expect(field.defaultValue).toBe('o3');
  });

  test('CODEX_TIMEOUT_MS has expected min/max bounds', () => {
    const field = findField('CODEX_TIMEOUT_MS');

    expect(field.envKey).toBe('CODEX_TIMEOUT_MS');
    expect(field.group).toBe('review');
    expect(field.type).toBe('number');
    expect(field.sensitive).toBe(false);
    expect(field.min).toBe(30000);
    expect(field.max).toBe(600000);
    expect(field.defaultValue).toBe(300000);
  });

  test('CODEX_REVIEW_PROMPT exists in review group', () => {
    const field = findField('CODEX_REVIEW_PROMPT');

    expect(field.envKey).toBe('CODEX_REVIEW_PROMPT');
    expect(field.group).toBe('review');
    expect(field.type).toBe('text');
    expect(field.sensitive).toBe(false);
  });
});
