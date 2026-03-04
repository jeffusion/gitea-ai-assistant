// @ts-expect-error bun:test is provided by Bun at runtime
declare module 'bun:test' {
  export const describe: any;
  export const test: any;
  export const expect: any;
}

// @ts-expect-error bun:test is provided by Bun at runtime
import { describe, expect, test } from 'bun:test';
import { toAnthropicTools, toGeminiTools, toOpenAITools } from '../tool-converter';
import type { LLMToolDefinition } from '../types';

const SAMPLE_TOOLS: LLMToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['location'],
    },
  },
  {
    name: 'search_code',
    description: 'Search codebase for a pattern',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
    },
  },
];

describe('tool-converter', () => {
  // ─── toOpenAITools ──────────────────────────────────────────────────

  describe('toOpenAITools()', () => {
    test('wraps each tool in { type: "function", function: {...} }', () => {
      const result = toOpenAITools(SAMPLE_TOOLS);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a location',
          parameters: SAMPLE_TOOLS[0].parameters,
        },
      });
      expect(result[1]).toEqual({
        type: 'function',
        function: {
          name: 'search_code',
          description: 'Search codebase for a pattern',
          parameters: SAMPLE_TOOLS[1].parameters,
        },
      });
    });

    test('returns empty array for empty input', () => {
      expect(toOpenAITools([])).toEqual([]);
    });

    test('preserves nested parameter schema', () => {
      const tools: LLMToolDefinition[] = [
        {
          name: 'complex',
          description: 'Complex params',
          parameters: {
            type: 'object',
            properties: {
              nested: {
                type: 'object',
                properties: {
                  deep: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      ];
      const result = toOpenAITools(tools) as any;
      expect(result[0].function.parameters.properties.nested.properties.deep.type).toBe('array');
    });
  });

  // ─── toAnthropicTools ───────────────────────────────────────────────

  describe('toAnthropicTools()', () => {
    test('maps to { name, description, input_schema }', () => {
      const result = toAnthropicTools(SAMPLE_TOOLS);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather for a location',
        input_schema: SAMPLE_TOOLS[0].parameters,
      });
      expect(result[1]).toEqual({
        name: 'search_code',
        description: 'Search codebase for a pattern',
        input_schema: SAMPLE_TOOLS[1].parameters,
      });
    });

    test('returns empty array for empty input', () => {
      expect(toAnthropicTools([])).toEqual([]);
    });

    test('uses input_schema (not parameters)', () => {
      const result = toAnthropicTools(SAMPLE_TOOLS) as any;
      expect(result[0]).toHaveProperty('input_schema');
      expect(result[0]).not.toHaveProperty('parameters');
    });
  });

  // ─── toGeminiTools ──────────────────────────────────────────────────

  describe('toGeminiTools()', () => {
    test('wraps all tools in a single functionDeclarations array', () => {
      const result = toGeminiTools(SAMPLE_TOOLS);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('functionDeclarations');

      const decls = (result[0] as any).functionDeclarations;
      expect(decls).toHaveLength(2);
      expect(decls[0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather for a location',
        parameters: SAMPLE_TOOLS[0].parameters,
      });
      expect(decls[1]).toEqual({
        name: 'search_code',
        description: 'Search codebase for a pattern',
        parameters: SAMPLE_TOOLS[1].parameters,
      });
    });

    test('returns single-element array even for one tool', () => {
      const result = toGeminiTools([SAMPLE_TOOLS[0]]);
      expect(result).toHaveLength(1);
      expect((result[0] as any).functionDeclarations).toHaveLength(1);
    });

    test('returns single-element with empty declarations for empty input', () => {
      const result = toGeminiTools([]);
      expect(result).toHaveLength(1);
      expect((result[0] as any).functionDeclarations).toHaveLength(0);
    });
  });

  // ─── Cross-format comparison ────────────────────────────────────────

  describe('cross-format consistency', () => {
    test('all formats preserve tool name and description', () => {
      const openai = toOpenAITools(SAMPLE_TOOLS) as any;
      const anthropic = toAnthropicTools(SAMPLE_TOOLS) as any;
      const gemini = (toGeminiTools(SAMPLE_TOOLS)[0] as any).functionDeclarations;

      for (let i = 0; i < SAMPLE_TOOLS.length; i++) {
        expect(openai[i].function.name).toBe(SAMPLE_TOOLS[i].name);
        expect(anthropic[i].name).toBe(SAMPLE_TOOLS[i].name);
        expect(gemini[i].name).toBe(SAMPLE_TOOLS[i].name);

        expect(openai[i].function.description).toBe(SAMPLE_TOOLS[i].description);
        expect(anthropic[i].description).toBe(SAMPLE_TOOLS[i].description);
        expect(gemini[i].description).toBe(SAMPLE_TOOLS[i].description);
      }
    });
  });
});
