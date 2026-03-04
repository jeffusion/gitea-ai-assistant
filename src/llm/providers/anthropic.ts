/**
 * Anthropic Messages API adapter.
 *
 * Key differences from OpenAI:
 * - System message → `system` top-level param (not in messages array)
 * - No native JSON mode → prompt injection + JSON.parse with regex fallback
 * - Tool results → role='user' with tool_result content blocks
 * - Finish reasons: end_turn→stop, tool_use→tool_calls, max_tokens→length
 */

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from '../capabilities';
import {
  LLMAuthError,
  LLMConnectionError,
  LLMContextLengthError,
  LLMRateLimitError,
  LLMResponseError,
} from '../errors';
import { toAnthropicTools } from '../tool-converter';
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMFinishReason,
  LLMMessage,
  LLMToolCall,
} from '../types';
import type { LLMProvider, ProviderFactory } from './base';

const TYPE = 'anthropic';

const JSON_MODE_SUFFIX =
  '\n\nYou MUST respond with valid JSON only. No markdown, no explanation, no other text outside the JSON object.';

function mapStopReason(reason: string | null | undefined): LLMFinishReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

/**
 * Separate system messages from conversation messages.
 * Anthropic requires system as a top-level param, not inside the messages array.
 */
function convertMessages(
  messages: LLMMessage[],
  jsonMode: boolean
): { system: string | undefined; anthropicMessages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = jsonMode ? msg.content + JSON_MODE_SUFFIX : msg.content;
      system = system ? `${system}\n${text}` : text;
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results go as user messages with tool_result content block
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      }
      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }

    anthropicMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    });
  }

  // If JSON mode requested but no system message existed, create one
  if (jsonMode && !system) {
    system = JSON_MODE_SUFFIX.trim();
  }

  return { system, anthropicMessages };
}

/**
 * Try to extract JSON from content that might have markdown wrapping.
 * Falls back to returning the raw content.
 */
function extractJson(content: string): string {
  // Try direct parse first
  try {
    JSON.parse(content);
    return content;
  } catch {
    // Noop — try regex extraction
  }

  // Try extracting from ```json ... ``` blocks
  const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch?.[1]) {
    try {
      JSON.parse(jsonBlockMatch[1].trim());
      return jsonBlockMatch[1].trim();
    } catch {
      // Noop
    }
  }

  // Try finding first { ... } or [ ... ]
  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    try {
      JSON.parse(objectMatch[0]);
      return objectMatch[0];
    } catch {
      // Noop
    }
  }

  return content;
}

class AnthropicProvider implements LLMProvider {
  readonly type = TYPE;
  readonly capabilities: ProviderCapabilities;
  private client: Anthropic;
  private defaultModel: string;

  constructor(config: {
    baseUrl?: string;
    apiKey: string;
    defaultModel: string;
    extraConfig: Record<string, unknown>;
  }) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.defaultModel = config.defaultModel;
    this.capabilities = { ...DEFAULT_CAPABILITIES.anthropic };
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const model = request.model || this.defaultModel;
    const jsonMode = request.responseFormat === 'json';
    const { system, anthropicMessages } = convertMessages(request.messages, jsonMode);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      messages: anthropicMessages,
      max_tokens: request.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) as any } : {}),
    };

    try {
      const response = await this.client.messages.create(params);

      let content: string | null = null;
      const toolCalls: LLMToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content = (content || '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      // JSON mode fallback: extract JSON from content
      if (jsonMode && content) {
        content = extractJson(content);
      }

      return {
        content,
        toolCalls,
        finishReason: mapStopReason(response.stop_reason),
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        raw: response,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    const models: string[] = [];
    for await (const page of response.iterPages()) {
      models.push(...page.data.map((model) => model.id));
    }
    return models;
  }

  private wrapError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      if (error.status === 401) return new LLMAuthError(TYPE, error.message);
      if (error.status === 429) return new LLMRateLimitError(TYPE);
      if (error.status === 400 && error.message?.includes('too long'))
        return new LLMContextLengthError(TYPE, error.message);
      if (error.status && error.status >= 500)
        return new LLMConnectionError(TYPE, error.message, error.status);
      return new LLMResponseError(TYPE, error.message);
    }
    if (
      error instanceof Error &&
      (error.message.includes('ECONNREFUSED') || error.message.includes('fetch'))
    ) {
      return new LLMConnectionError(TYPE, error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export const createAnthropicProvider: ProviderFactory = (config) => new AnthropicProvider(config);
