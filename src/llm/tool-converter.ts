/**
 * Converts internal LLMToolDefinition to provider-native tool formats.
 * Called by each adapter in their chat() method.
 */

import type { LLMToolDefinition } from './types';

export function toOpenAITools(tools: LLMToolDefinition[]): object[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function toAnthropicTools(tools: LLMToolDefinition[]): object[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function toGeminiTools(tools: LLMToolDefinition[]): object[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}
