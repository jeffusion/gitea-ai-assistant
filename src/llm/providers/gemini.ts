/**
 * Google Gemini generateContent API adapter.
 *
 * Key differences from OpenAI:
 * - System message → systemInstruction param
 * - Role 'assistant' → 'model'
 * - Tool calls → functionCall parts; tool results → functionResponse parts
 * - Finish reasons: STOP, FUNCTION_CALL (unofficial—actually STOP), MAX_TOKENS, SAFETY
 * - Token usage: usageMetadata.{promptTokenCount, candidatesTokenCount}
 */

import { type Content, GoogleGenAI, type Part } from '@google/genai';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from '../capabilities';
import {
  LLMAuthError,
  LLMConnectionError,
  LLMContextLengthError,
  LLMRateLimitError,
  LLMResponseError,
} from '../errors';
import { toGeminiTools } from '../tool-converter';
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMFinishReason,
  LLMMessage,
  LLMToolCall,
} from '../types';
import type { LLMProvider, ProviderFactory } from './base';

const TYPE = 'gemini';

function mapFinishReason(reason: string | undefined): LLMFinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function convertMessages(messages: LLMMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = systemInstruction ? `${systemInstruction}\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results → function role with functionResponse part
      contents.push({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: msg.toolCallId || 'unknown',
              response: safeParseJson(msg.content),
            },
          } as Part,
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts: Part[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: safeParseJson(tc.arguments),
          },
        } as Part);
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // Gemini uses 'model' instead of 'assistant'
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({
      role,
      parts: [{ text: msg.content }],
    });
  }

  return { systemInstruction, contents };
}

function safeParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return { result: str };
  }
}

class GeminiProvider implements LLMProvider {
  readonly type = TYPE;
  readonly capabilities: ProviderCapabilities;
  private genAI: GoogleGenAI;
  private defaultModel: string;

  constructor(config: {
    baseUrl?: string;
    apiKey: string;
    defaultModel: string;
    extraConfig: Record<string, unknown>;
  }) {
    this.genAI = new GoogleGenAI({ apiKey: config.apiKey });
    this.defaultModel = config.defaultModel;
    this.capabilities = { ...DEFAULT_CAPABILITIES.gemini };
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const modelId = request.model || this.defaultModel;
    const { systemInstruction, contents } = convertMessages(request.messages);

    try {
      const response = await this.genAI.models.generateContent({
        model: modelId,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
          ...(request.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
          ...(request.tools?.length ? { tools: toGeminiTools(request.tools) as any } : {}),
        },
      });
      const candidate = response.candidates?.[0];

      let content: string | null = null;
      const toolCalls: LLMToolCall[] = [];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('text' in part && part.text) {
            content = (content || '') + part.text;
          }
          if ('functionCall' in part && part.functionCall) {
            const toolName = String(part.functionCall.name ?? 'unknown');
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: toolName,
              arguments: JSON.stringify(part.functionCall.args || {}),
            });
          }
        }
      }

      const hasFunctionCalls = toolCalls.length > 0;
      const finishReason = hasFunctionCalls
        ? 'tool_calls'
        : mapFinishReason(candidate?.finishReason as string | undefined);

      const usage = response.usageMetadata;

      return {
        content,
        toolCalls,
        finishReason,
        usage: {
          promptTokens: usage?.promptTokenCount ?? 0,
          completionTokens: usage?.candidatesTokenCount ?? 0,
          totalTokens: usage?.totalTokenCount ?? 0,
        },
        raw: response,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const results: number[][] = [];
      for (const text of texts) {
        const result = await this.genAI.models.embedContent({
          model: this.defaultModel,
          contents: text,
        });
        results.push(result.embeddings?.[0]?.values ?? []);
      }
      return results;
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async listModels(): Promise<string[]> {
    const pager = await this.genAI.models.list();
    const models: string[] = [];
    for await (const model of pager) {
      if (model.name) {
        models.push(model.name.replace('models/', ''));
      }
    }
    return models;
  }

  private wrapError(error: unknown): Error {
    if (error instanceof Error) {
      const msg = error.message;
      if (msg.includes('API_KEY_INVALID') || msg.includes('401'))
        return new LLMAuthError(TYPE, msg);
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED'))
        return new LLMRateLimitError(TYPE);
      if (msg.includes('context') || msg.includes('too long'))
        return new LLMContextLengthError(TYPE, msg);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch') || msg.includes('500'))
        return new LLMConnectionError(TYPE, msg);
      return new LLMResponseError(TYPE, msg);
    }
    return new Error(String(error));
  }
}

export const createGeminiProvider: ProviderFactory = (config) => new GeminiProvider(config);
