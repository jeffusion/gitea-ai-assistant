/**
 * OpenAI Compatible adapter — for any service implementing the OpenAI chat.completions API.
 * This is the existing format used by the codebase today.
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

const TYPE = 'openai_compatible';

function mapFinishReason(reason: string | null | undefined): LLMFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content,
        tool_call_id: msg.toolCallId!,
      };
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return {
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content,
    };
  });
}

function extractToolCalls(choice: OpenAI.ChatCompletion.Choice): LLMToolCall[] {
  const toolCalls = choice.message.tool_calls;
  if (!toolCalls?.length) return [];
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

type OpenAIToolChoice = NonNullable<OpenAI.ChatCompletionCreateParamsNonStreaming['tool_choice']>;

function isNamedToolChoice(value: unknown): value is {
  type: 'function';
  function: { name: string };
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'function') return false;
  const fn = candidate.function;
  return Boolean(
    fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string'
  );
}

function toOpenAIToolChoice(value: unknown): OpenAIToolChoice | undefined {
  if (value === 'auto' || value === 'none' || value === 'required') {
    return value;
  }
  if (isNamedToolChoice(value)) {
    return {
      type: 'function',
      function: {
        name: value.function.name,
      },
    };
  }
  return undefined;
}

export function buildOpenAICompatibleChatParams(
  request: LLMChatRequest,
  model: string
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const toolChoice = toOpenAIToolChoice(request.providerOptions?.tool_choice);
  return {
    model,
    messages: toOpenAIMessages(request.messages),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    ...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

class OpenAICompatibleProvider implements LLMProvider {
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
      baseURL: config.baseUrl || 'https://api.openai.com/v1',
      apiKey: config.apiKey,
      ...(config.extraConfig.organization
        ? { organization: config.extraConfig.organization as string }
        : {}),
    });
    this.defaultModel = config.defaultModel;
    this.capabilities = { ...DEFAULT_CAPABILITIES.openai_compatible };
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const model = request.model || this.defaultModel;
    const params = buildOpenAICompatibleChatParams(request, model);

    try {
      const response = await this.client.chat.completions.create(params);
      const choice = response.choices[0];

      return {
        content: choice?.message?.content ?? null,
        toolCalls: choice ? extractToolCalls(choice) : [],
        finishReason: mapFinishReason(choice?.finish_reason),
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
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

export const createOpenAICompatibleProvider: ProviderFactory = (config) =>
  new OpenAICompatibleProvider(config);
