/**
 * Token Counter — estimates token counts for context budget management.
 *
 * Uses a simple chars-to-tokens ratio estimation by default (chars / 3.5),
 * which is a widely-used approximation for English/code content.
 *
 * Context window lookup strategy (ordered by priority):
 *   1. Dynamic catalog fetched from models.dev at startup (3000+ models, always fresh)
 *   2. Static tokenlens built-in registry (offline fallback)
 *   3. Conservative 128k default for truly unknown models
 */

import type { ModelCatalog, ProviderModel } from '@tokenlens/core';
import { fetchModels, getContextWindow as tlGetContextWindow } from 'tokenlens';

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default chars-per-token ratio.
 * English text: ~4 chars/token. Code: ~3.5 chars/token.
 * We use 3.5 to be conservative (slightly over-estimate tokens).
 */
const DEFAULT_CHARS_PER_TOKEN = 3.5;

/**
 * Default context window when model is unknown.
 * Conservative: assume 128k to avoid overflow on most modern models.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Reserve tokens for system prompt, output, and overhead.
 * This is subtracted from the total context window to get the usable budget.
 */
const RESERVED_TOKENS = 4_000;

/** How often to refresh the dynamic catalog (24 hours). */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// TokenCounter
// ---------------------------------------------------------------------------

export class TokenCounter {
  private readonly charsPerToken: number;

  /** Dynamic catalog fetched from models.dev. null until first refresh. */
  private catalog: ModelCatalog | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
    this.charsPerToken = charsPerToken;
  }

  // -------------------------------------------------------------------------
  // Token estimation
  // -------------------------------------------------------------------------

  /**
   * Estimate token count for a string.
   */
  count(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }

  /**
   * Clip text to fit within a token budget.
   * Returns the text truncated to approximately `maxTokens` tokens.
   */
  clip(text: string, maxTokens: number): string {
    const maxChars = Math.floor(maxTokens * this.charsPerToken);
    if (text.length <= maxChars) {
      return text;
    }
    const lastNewline = text.lastIndexOf('\n', maxChars);
    const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
    return `${text.slice(0, cutPoint)}\n... [truncated, exceeded ${maxTokens} token budget]`;
  }

  // -------------------------------------------------------------------------
  // Context window lookup
  // -------------------------------------------------------------------------

  /**
   * Get the usable token budget for a given model.
   * = context_window - reserved_tokens
   */
  getUsableBudget(model: string): number {
    const contextWindow = this.getContextWindow(model);
    const budget = contextWindow - RESERVED_TOKENS;
    return Math.max(budget, 1000); // never return less than 1000
  }

  /**
   * Get the context window size for a model.
   *
   * Lookup order:
   *   1. Dynamic catalog (from models.dev, refreshed every 24h)
   *   2. Static tokenlens registry (built into the package)
   *   3. DEFAULT_CONTEXT_WINDOW (128k)
   */
  getContextWindow(model: string): number {
    // 1. Try dynamic catalog first
    const dynamicResult = this.lookupFromCatalog(model);
    if (dynamicResult && dynamicResult > 0) {
      return dynamicResult;
    }

    // 2. Fall back to static tokenlens registry
    const staticResult = tlGetContextWindow(model);
    const staticWindow = staticResult?.combinedMax ?? staticResult?.totalMax;
    if (staticWindow && staticWindow > 0) {
      return staticWindow;
    }

    // 3. Default
    logger.debug(
      `Unknown model "${model}", using default context window ${DEFAULT_CONTEXT_WINDOW}`
    );
    return DEFAULT_CONTEXT_WINDOW;
  }

  // -------------------------------------------------------------------------
  // Dynamic catalog management
  // -------------------------------------------------------------------------

  /**
   * Fetch the latest model catalog from models.dev and cache it.
   * Called at engine startup; silently falls back to static data on failure.
   * Schedules automatic refresh every 24h.
   */
  async refreshCatalog(): Promise<void> {
    try {
      const catalog = await fetchModels();
      this.catalog = catalog;

      let modelCount = 0;
      for (const provider of Object.values(catalog)) {
        modelCount += Object.keys(provider.models || {}).length;
      }

      logger.info('Model catalog refreshed from models.dev', {
        providers: Object.keys(catalog).length,
        models: modelCount,
      });
    } catch (error) {
      logger.warn('Failed to fetch model catalog from models.dev, using static data', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.scheduleNextRefresh();
  }

  /**
   * Stop the background refresh timer (for clean shutdown).
   */
  stopRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Whether a dynamic catalog has been loaded.
   */
  get hasCatalog(): boolean {
    return this.catalog !== null;
  }

  /**
   * Get chat model names for a given models.dev provider key.
   * Returns model IDs suitable for the provider, filtered to chat models only.
   * Used by the API to serve dynamic model suggestions to the frontend.
   */
  getModelSuggestions(providerKey: string): string[] {
    if (!this.catalog) return [];

    const provider = this.catalog[providerKey];
    if (!provider?.models) return [];

    return Object.entries(provider.models)
      .filter(([id, m]) => {
        // Exclude non-chat models (embeddings, image, audio, search, TTS)
        const lower = id.toLowerCase();
        return (
          !lower.includes('embed') &&
          !lower.includes('tts') &&
          !lower.includes('whisper') &&
          !lower.includes('dall') &&
          !lower.includes('image') &&
          !lower.includes('audio') &&
          !lower.includes('search') &&
          !lower.includes('transcribe') &&
          !lower.includes('moderat') &&
          !lower.includes('realtime') &&
          !lower.includes('computer-use') &&
          m.limit?.context !== undefined
        );
      })
      .sort((a, b) => {
        // Sort by release date descending (newest first), then by context window
        const dateA = a[1].release_date || '1970-01';
        const dateB = b[1].release_date || '1970-01';
        if (dateB !== dateA) return dateB.localeCompare(dateA);
        return (b[1].limit?.context || 0) - (a[1].limit?.context || 0);
      })
      .map(([id]) => id);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Look up a model's context window from the dynamic catalog.
   * Searches across all providers for the model ID.
   */
  private lookupFromCatalog(model: string): number | undefined {
    if (!this.catalog) return undefined;

    // Search all providers for the model
    for (const provider of Object.values(this.catalog)) {
      const entry: ProviderModel | undefined = provider.models?.[model];
      if (entry?.limit?.context) {
        return entry.limit.context;
      }
    }

    return undefined;
  }

  private scheduleNextRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setTimeout(() => {
      this.refreshCatalog().catch((error) => {
        logger.warn('Background catalog refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, CATALOG_TTL_MS);
    // Don't prevent process exit
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === 'object' &&
      'unref' in this.refreshTimer
    ) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }
}

// Singleton instance
export const tokenCounter = new TokenCounter();
