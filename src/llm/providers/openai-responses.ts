/**
 * OpenAI Responses API adapter — uses the newer responses.create endpoint.
 * System instructions are passed as the `instructions` parameter instead of a system message.
 */

import OpenAI from 'openai';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from '../capabilities';
import {
  LLMAuthError,
  LLMConnectionError,
  LLMContextLengthError,
  LLMRateLimitError,
  LLMResponseError,
} from '../errors';
import { toOpenAITools } from '../tool-converter';
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMFinishReason,
  LLMMessage,
  LLMToolCall,
} from '../types';
import type { LLMProvider, ProviderFactory } from './base';

const TYPE = 'openai_responses';

function mapStatus(status: string | undefined): LLMFinishReason {
  switch (status) {
    case 'completed':
      return 'stop';
    case 'incomplete':
      return 'length';
    default:
      return 'stop';
  }
}

/**
 * Extract system instructions and build input items from unified messages.
 * System messages → `instructions` parameter.
 * Remaining messages → `input` array.
 */
function convertMessages(messages: LLMMessage[]): {
  instructions: string | undefined;
  input: any[];
} {
  let instructions: string | undefined;
  const input: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions = instructions ? `${instructions}\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: msg.content,
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      // Emit function_call items for each tool call
      for (const tc of msg.toolCalls) {
        input.push({
          type: 'function_call',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      // Also emit text if present
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }

    input.push({
      role: msg.role,
      content: msg.content,
    });
  }

  return { instructions, input };
}

class OpenAIResponsesProvider implements LLMProvider {
  readonly type = TYPE;
  readonly capabilities: ProviderCapabilities;
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: {
    baseUrl?: string;
    apiKey: string;
    defaultModel: string;
    extraConfig: Record<string, unknown>;
  }) {
    this.client = new OpenAI({
      baseURL: config.baseUrl || undefined,
      apiKey: config.apiKey,
    });
    this.defaultModel = config.defaultModel;
    this.capabilities = { ...DEFAULT_CAPABILITIES.openai_responses };
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const model = request.model || this.defaultModel;
    const { instructions, input } = convertMessages(request.messages);

    const params: any = {
      model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
      ...(request.responseFormat === 'json' ? { text: { format: { type: 'json_object' } } } : {}),
      ...(request.tools?.length
        ? {
            tools: toOpenAITools(request.tools).map((t: any) => ({
              type: 'function',
              ...t.function,
            })),
          }
        : {}),
    };

    try {
      const response = await this.client.responses.create(params);

      // Extract content and tool calls from output
      let content: string | null = null;
      const toolCalls: LLMToolCall[] = [];

      for (const item of response.output || []) {
        if (item.type === 'message') {
          for (const block of (item as any).content || []) {
            if (block.type === 'output_text') {
              content = (content || '') + block.text;
            }
          }
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: (item as any).id || (item as any).call_id || '',
            name: (item as any).name,
            arguments: (item as any).arguments || '{}',
          });
        }
      }

      return {
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : mapStatus(response.status),
        usage: {
          promptTokens: (response.usage as any)?.input_tokens ?? 0,
          completionTokens: (response.usage as any)?.output_tokens ?? 0,
          totalTokens:
            ((response.usage as any)?.input_tokens ?? 0) +
            ((response.usage as any)?.output_tokens ?? 0),
        },
        raw: response,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.defaultModel,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  private wrapError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) return new LLMAuthError(TYPE, error.message);
      if (error.status === 429) return new LLMRateLimitError(TYPE);
      if (error.status === 400 && error.message?.includes('context_length'))
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

export const createOpenAIResponsesProvider: ProviderFactory = (config) =>
  new OpenAIResponsesProvider(config);
