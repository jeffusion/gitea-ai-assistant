import { describe, expect, test } from 'bun:test';
import { createMockChatForRole, isE2EMockActive } from './llm-mock';

describe('LLM Mock', () => {
  test('specialist role returns preset findings', async () => {
    const mock = createMockChatForRole();
    const response = await mock('specialist', {
      messages: [
        { role: 'system', content: 'You are a code reviewer' },
        { role: 'user', content: 'Review this code' },
      ],
    });

    expect(response.finishReason).toBe('stop');
    expect(response.toolCalls).toEqual([]);
    const parsed = JSON.parse(response.content!);
    expect(parsed.findings).toBeDefined();
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.findings[0].severity).toBe('high');
    expect(parsed.findings[0].path).toBe('src/user-handler.ts');
  });

  test('planner role returns preset summary', async () => {
    const mock = createMockChatForRole();
    const response = await mock('planner', {
      messages: [{ role: 'user', content: 'Summarize this diff' }],
    });

    const parsed = JSON.parse(response.content!);
    expect(parsed.summary).toBeDefined();
    expect(parsed.keyConcerns).toBeDefined();
  });

  test('unknown role falls back to specialist response', async () => {
    const mock = createMockChatForRole();
    const response = await mock('judge' as any, {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(response.content).toBeDefined();
    expect(response.finishReason).toBe('stop');
  });

  test('isE2EMockActive returns true when E2E_MOCK_LLM=1', () => {
    const orig = process.env.E2E_MOCK_LLM;
    process.env.E2E_MOCK_LLM = '1';
    expect(isE2EMockActive()).toBe(true);
    process.env.E2E_MOCK_LLM = orig;
  });

  test('isE2EMockActive returns false when E2E_MOCK_LLM is not set', () => {
    const orig = process.env.E2E_MOCK_LLM;
    process.env.E2E_MOCK_LLM = undefined;
    expect(isE2EMockActive()).toBe(false);
    if (orig !== undefined) process.env.E2E_MOCK_LLM = orig;
  });
});
