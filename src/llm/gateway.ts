/**
 * LLM Gateway — the sole entry point for all business-layer LLM calls.
 *
 * Responsibilities:
 *   1. Load (or cache) LLMProvider instances with decrypted API keys
 *   2. Route chat() calls to the correct adapter
 *   3. Invalidate cache when provider config changes via UI
 *   4. Concurrency control + retry-with-backoff for resilience
 */

import { providerRepo } from '../db/repositories/provider-repo';
import { secretRepo } from '../db/repositories/secret-repo';
import { LLMAuthError, LLMError } from './errors';
import { createAnthropicProvider } from './providers/anthropic';
import type { LLMProvider } from './providers/base';
import { createGeminiProvider } from './providers/gemini';
import { createOpenAICompatibleProvider } from './providers/openai-compatible';
import { createOpenAIResponsesProvider } from './providers/openai-responses';
import { LLMSemaphore, type RetryOptions, withResilience } from './resilience';
import type { LLMChatRequest, LLMChatResponse, ProviderType } from './types';

type ProviderFactoryFn = (config: {
  baseUrl?: string;
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
}) => LLMProvider;

const PROVIDER_FACTORIES: Record<ProviderType, ProviderFactoryFn> = {
  openai_compatible: createOpenAICompatibleProvider,
  openai_responses: createOpenAIResponsesProvider,
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
};

export class LLMGateway {
  private cache = new Map<string, LLMProvider>();
  private semaphore: LLMSemaphore;
  private retryOptions: Partial<RetryOptions>;

  constructor(maxConcurrent = 4, retryOptions?: Partial<RetryOptions>) {
    this.semaphore = new LLMSemaphore(maxConcurrent);
    this.retryOptions = retryOptions ?? {};
  }

  /**
   * Reconfigure resilience settings (called when admin changes config via UI).
   */
  updateResilienceConfig(maxConcurrent: number, retryOptions?: Partial<RetryOptions>): void {
    this.semaphore = new LLMSemaphore(maxConcurrent);
    this.retryOptions = retryOptions ?? this.retryOptions;
  }

  /**
   * Direct call to a specific provider (used for connection testing).
   */
  async chatDirect(providerId: string, request: LLMChatRequest): Promise<LLMChatResponse> {
    return withResilience(
      this.semaphore,
      () => {
        const provider = this.getOrCreateProvider(providerId);
        return provider.chat(request);
      },
      this.retryOptions,
      `direct:${providerId}`
    );
  }

  /**
   * Invalidate cached provider instance (call when config/key changes via UI).
   */
  invalidateProvider(providerId: string): void {
    this.cache.delete(providerId);
  }

  /**
   * Clear all cached providers (call on global config change).
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Get or create a provider instance (for direct access like listing models). */
  getProviderInstance(providerId: string): LLMProvider {
    return this.getOrCreateProvider(providerId);
  }

  private getOrCreateProvider(providerId: string): LLMProvider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;

    const providerRow = providerRepo.getById(providerId);
    if (!providerRow) {
      throw new LLMError(`Provider '${providerId}' not found in database`, 'gateway');
    }
    if (!providerRow.is_enabled) {
      throw new LLMError(`Provider '${providerRow.name}' is disabled`, 'gateway');
    }

    const apiKey = secretRepo.get(providerId);
    if (!apiKey) {
      throw new LLMAuthError(
        providerRow.type,
        `No API key configured for provider '${providerRow.name}'`
      );
    }

    const factory = PROVIDER_FACTORIES[providerRow.type as ProviderType];
    if (!factory) {
      throw new LLMError(`Unknown provider type '${providerRow.type}'`, providerRow.type);
    }

    let extraConfig: Record<string, unknown> = {};
    try {
      extraConfig = JSON.parse(providerRow.extra_config || '{}');
    } catch {
      // Invalid JSON in extra_config — use empty
    }

    const provider = factory({
      baseUrl: providerRow.base_url || undefined,
      apiKey,
      defaultModel: providerRow.default_model,
      extraConfig,
    });

    this.cache.set(providerId, provider);
    return provider;
  }
}

// Singleton instance
export const llmGateway = new LLMGateway();
