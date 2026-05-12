/**
 * Unified LLM types — provider-agnostic request/response format.
 *
 * All business code uses these types exclusively.
 * Provider adapters translate to/from these types.
 */

// ---------------------------------------------------------------------------
// Model Role
// ---------------------------------------------------------------------------

/** Business role that maps to a specific provider + model via DB config. */
export type ModelRole = 'planner' | 'specialist';

export const MODEL_ROLES: readonly ModelRole[] = ['planner', 'specialist'] as const;

// ---------------------------------------------------------------------------
// Provider Type
// ---------------------------------------------------------------------------

export type ProviderType = 'openai_compatible' | 'openai_responses' | 'anthropic' | 'gemini';

export const PROVIDER_TYPES: readonly ProviderType[] = [
  'openai_compatible',
  'openai_responses',
  'anthropic',
  'gemini',
] as const;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Unified message format (internal representation, hides provider differences). */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** When role='tool', the ID of the tool call this result corresponds to. */
  toolCallId?: string;
  /** When role='assistant', any tool calls the model wants to make. */
  toolCalls?: LLMToolCall[];
}

/** A single tool call from the model. */
export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON-serialized arguments */
  arguments: string;
}

/** Tool definition in provider-agnostic format. Converted to native format by tool-converter. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Unified chat request — provider adapters translate this to native format. */
export interface LLMChatRequest {
  messages: LLMMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Abstract JSON mode: adapters handle native support or prompt injection fallback. */
  responseFormat?: 'text' | 'json';
  tools?: LLMToolDefinition[];
  /** Provider-specific passthrough config (e.g. Anthropic thinking, Gemini safetySettings). */
  providerOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Unified chat response — provider adapters normalize to this format. */
export interface LLMChatResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  finishReason: LLMFinishReason;
  usage: LLMUsage;
  /** Raw provider response preserved for debugging. */
  raw?: unknown;
}

export type LLMFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
