/**
 * LLM Gateway — the sole entry point for all business-layer LLM calls.
 *
 * Responsibilities:
 *   1. Look up model_role_assignments → provider_id + model for a given role
 *   2. Load (or cache) LLMProvider instances with decrypted API keys
 *   3. Route chat() calls to the correct adapter
 *   4. Invalidate cache when provider config changes via UI
 */

import { type ModelRole, modelRoleRepo } from '../db/repositories/model-role-repo';
import { providerRepo } from '../db/repositories/provider-repo';
import { secretRepo } from '../db/repositories/secret-repo';
import { LLMAuthError, LLMError, LLMNoProviderError } from './errors';
import { createAnthropicProvider } from './providers/anthropic';
import type { LLMProvider } from './providers/base';
import { createGeminiProvider } from './providers/gemini';
import { createOpenAICompatibleProvider } from './providers/openai-compatible';
import { createOpenAIResponsesProvider } from './providers/openai-responses';
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

  /**
   * Call LLM by business role. The role determines which provider + model to use.
   * The `model` field in the request is ignored — it's resolved from the DB assignment.
   */
  async chatForRole(
    role: ModelRole,
    request: Omit<LLMChatRequest, 'model'>
  ): Promise<LLMChatResponse> {
    const assignment = modelRoleRepo.getByRole(role);
    if (!assignment) throw new LLMNoProviderError(role);

    const provider = this.getOrCreateProvider(assignment.provider_id);
    return provider.chat({ ...request, model: assignment.model });
  }

  /**
   * Direct call to a specific provider (used for connection testing).
   */
  async chatDirect(providerId: string, request: LLMChatRequest): Promise<LLMChatResponse> {
    const provider = this.getOrCreateProvider(providerId);
    return provider.chat(request);
  }

  /**
   * Embedding via the provider assigned to the 'embedding' role.
   */
  async embedForRole(texts: string[]): Promise<number[][]> {
    const assignment = modelRoleRepo.getByRole('embedding');
    if (!assignment) throw new LLMNoProviderError('embedding');

    const provider = this.getOrCreateProvider(assignment.provider_id);
    if (!provider.embed) {
      throw new LLMError(`Provider '${provider.type}' does not support embeddings`, provider.type);
    }
    return provider.embed(texts);
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
