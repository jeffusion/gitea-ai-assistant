import { describe, expect, test } from 'bun:test';
import { buildOpenAICompatibleChatParams } from '../providers/openai-compatible';
import type { LLMChatRequest, LLMToolDefinition } from '../types';

const readFileTool: LLMToolDefinition = {
  name: 'read_file',
  description: 'Read a file from the workspace',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
    },
    required: ['file_path'],
  },
};

function makeRequest(providerOptions?: Record<string, unknown>): LLMChatRequest {
  return {
    model: 'ignored-model',
    messages: [{ role: 'user', content: 'Review this change' }],
    tools: [readFileTool],
    providerOptions,
  };
}

describe('OpenAI compatible provider params', () => {
  test('passes scalar tool_choice provider option to Chat Completions', () => {
    const params = buildOpenAICompatibleChatParams(
      makeRequest({ tool_choice: 'required' }),
      'gpt-4o'
    );

    expect(params.tool_choice).toBe('required');
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from the workspace',
          parameters: readFileTool.parameters,
        },
      },
    ]);
  });

  test('passes named function tool_choice provider option to Chat Completions', () => {
    const params = buildOpenAICompatibleChatParams(
      makeRequest({ tool_choice: { type: 'function', function: { name: 'read_file' } } }),
      'gpt-4o'
    );

    expect(params.tool_choice).toEqual({
      type: 'function',
      function: { name: 'read_file' },
    });
  });

  test('ignores invalid tool_choice provider option', () => {
    const params = buildOpenAICompatibleChatParams(
      makeRequest({ tool_choice: { type: 'function', function: {} } }),
      'gpt-4o'
    );

    expect(params.tool_choice).toBeUndefined();
  });
});
