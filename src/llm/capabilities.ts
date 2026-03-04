/**
 * Provider capability declarations.
 *
 * Each provider type declares what features it supports natively.
 * The Gateway and adapters use this to make runtime decisions
 * (e.g. prompt-inject JSON mode for Anthropic, skip embedding calls for non-supporting providers).
 */

import type { ProviderType } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Supports tool/function calling */
  supportsTools: boolean;
  /** Supports native JSON mode (vs. prompt injection + manual parsing) */
  supportsJsonMode: boolean;
  /** Supports SSE streaming */
  supportsStreaming: boolean;
  /** Supports embedding API */
  supportsEmbeddings: boolean;
  /** Supports image/multimodal input */
  supportsMultimodal: boolean;
  /** Max input token count (for pre-validation, avoids wasted API calls) */
  maxInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Default capabilities per provider type
// ---------------------------------------------------------------------------

export const DEFAULT_CAPABILITIES: Record<ProviderType, ProviderCapabilities> = {
  openai_compatible: {
    supportsTools: true,
    supportsJsonMode: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: false, // depends on actual model behind the compatible endpoint
  },
  openai_responses: {
    supportsTools: true,
    supportsJsonMode: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: true,
  },
  anthropic: {
    supportsTools: true,
    supportsJsonMode: false, // no native JSON mode; adapter uses prompt injection
    supportsStreaming: true,
    supportsEmbeddings: false,
    supportsMultimodal: true,
  },
  gemini: {
    supportsTools: true,
    supportsJsonMode: true, // responseMimeType: 'application/json'
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: true,
  },
};
