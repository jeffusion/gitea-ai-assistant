/**
 * LLMProvider abstract interface.
 *
 * Each adapter (openai-compatible, openai-responses, anthropic, gemini)
 * implements this interface. The Gateway only interacts with providers
 * through this contract.
 */

import type { ProviderCapabilities } from '../capabilities';
import type { LLMChatRequest, LLMChatResponse } from '../types';

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Provider type identifier (e.g. 'openai_compatible', 'anthropic'). */
  readonly type: string;

  /** Capability declaration for this provider. */
  readonly capabilities: ProviderCapabilities;

  /**
   * Core chat method. The Gateway only calls this method.
   *
   * Each adapter is responsible for:
   *   1. Converting LLMChatRequest to provider-native format
   *   2. Making the HTTP/SDK call
   *   3. Converting the native response to LLMChatResponse
   */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;

  /** Optional: embedding interface (only for providers that support it). */
  embed?(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

/** Factory function signature: create an LLMProvider from DB config + decrypted API key. */
export type ProviderFactory = (config: {
  baseUrl?: string;
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
}) => LLMProvider;
