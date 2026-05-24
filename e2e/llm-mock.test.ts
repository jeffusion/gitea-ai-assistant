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

  test('specialist role simulates autonomous search and cross-file reads when tools are available', async () => {
    const mock = createMockChatForRole();
    const tools = [
      {
        name: 'search_code',
        description: 'search',
        parameters: { type: 'object', properties: {} },
      },
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ];
    const messages = [
      { role: 'system' as const, content: 'You are a code reviewer' },
      { role: 'user' as const, content: 'Review this code' },
    ];

    const turn1 = await mock('specialist', { messages, tools });
    expect(turn1.finishReason).toBe('tool_calls');
    expect(turn1.toolCalls.map((toolCall) => toolCall.name)).toEqual(['search_code']);

    const turn2 = await mock('specialist', {
      messages: [
        ...messages,
        { role: 'assistant', content: '', toolCalls: turn1.toolCalls },
        { role: 'tool', toolCallId: 'e2e_search_user_handler', content: '{"matches":[]}' },
      ],
      tools,
    });
    expect(turn2.toolCalls.map((toolCall) => toolCall.name)).toEqual(['read_file']);
    expect(JSON.parse(turn2.toolCalls[0].arguments)).toEqual({ file_path: 'src/user-handler.ts' });

    const turn3 = await mock('specialist', {
      messages: [
        ...messages,
        { role: 'tool', toolCallId: 'e2e_search_user_handler', content: '{"matches":[]}' },
        { role: 'tool', toolCallId: 'e2e_read_caller', content: '{"path":"src/user-handler.ts"}' },
      ],
      tools,
    });
    expect(turn3.toolCalls.map((toolCall) => toolCall.name)).toEqual(['read_file']);
    expect(JSON.parse(turn3.toolCalls[0].arguments)).toEqual({ file_path: 'src/auth.ts' });

    const turn4 = await mock('specialist', {
      messages: [
        ...messages,
        { role: 'tool', toolCallId: 'e2e_search_user_handler', content: '{"matches":[]}' },
        { role: 'tool', toolCallId: 'e2e_read_caller', content: '{"path":"src/user-handler.ts"}' },
        { role: 'tool', toolCallId: 'e2e_read_callee', content: '{"path":"src/auth.ts"}' },
      ],
      tools,
    });
    expect(turn4.finishReason).toBe('stop');
    expect(turn4.toolCalls).toEqual([]);
    const parsed = JSON.parse(turn4.content!);
    expect(parsed.findings[0].detail).toContain('auth/user model');
    expect(parsed.findings[0].evidence).toContain('src/auth.ts');
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
