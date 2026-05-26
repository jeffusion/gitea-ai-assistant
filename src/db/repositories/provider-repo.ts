/**
 * Repository for llm_providers table.
 * CRUD operations for LLM provider configurations.
 */

import { getDatabase } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType = 'openai_compatible' | 'openai_responses' | 'anthropic' | 'gemini';

export interface ProviderRow {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string | null;
  default_model: string;
  is_enabled: number; // 0 or 1
  extra_config: string; // JSON string
  created_at: string;
  updated_at: string;
}

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  baseUrl?: string | null;
  defaultModel: string;
  extraConfig?: Record<string, unknown>;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string | null;
  defaultModel?: string;
  isEnabled?: boolean;
  extraConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const providerRepo = {
  /**
   * List all providers, optionally filtered by enabled status.
   */
  list(enabledOnly = false): ProviderRow[] {
    const db = getDatabase();
    if (enabledOnly) {
      return db
        .query('SELECT * FROM llm_providers WHERE is_enabled = 1 ORDER BY created_at')
        .all() as ProviderRow[];
    }
    return db.query('SELECT * FROM llm_providers ORDER BY created_at').all() as ProviderRow[];
  },

  /**
   * Get a single provider by ID.
   */
  getById(id: string): ProviderRow | null {
    const db = getDatabase();
    return (db.query('SELECT * FROM llm_providers WHERE id = ?').get(id) as ProviderRow) || null;
  },

  /**
   * Create a new provider. Returns the created row.
   */
  create(input: CreateProviderInput): ProviderRow {
    const db = getDatabase();
    const extraConfig = JSON.stringify(input.extraConfig || {});

    // Insert and let SQLite generate the ID via DEFAULT
    db.query(
      `INSERT INTO llm_providers (name, type, base_url, default_model, extra_config)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.name, input.type, input.baseUrl ?? null, input.defaultModel, extraConfig);

    // Retrieve the last inserted row (SQLite doesn't have RETURNING in all versions)
    const row = db
      .query('SELECT * FROM llm_providers WHERE rowid = last_insert_rowid()')
      .get() as ProviderRow;

    return row;
  },

  /**
   * Update an existing provider. Returns the updated row, or null if not found.
   */
  update(id: string, input: UpdateProviderInput): ProviderRow | null {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      values.push(input.name);
    }
    if (input.baseUrl !== undefined) {
      sets.push('base_url = ?');
      values.push(input.baseUrl);
    }
    if (input.defaultModel !== undefined) {
      sets.push('default_model = ?');
      values.push(input.defaultModel);
    }
    if (input.isEnabled !== undefined) {
      sets.push('is_enabled = ?');
      values.push(input.isEnabled ? 1 : 0);
    }
    if (input.extraConfig !== undefined) {
      sets.push('extra_config = ?');
      values.push(JSON.stringify(input.extraConfig));
    }

    if (sets.length === 0) return existing;

    sets.push("updated_at = datetime('now')");
    values.push(id);

    db.query(`UPDATE llm_providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.getById(id);
  },

  /**
   * Delete a provider by ID. Returns true if deleted.
   * CASCADE will also delete the associated secret.
   */
  delete(id: string): boolean {
    const db = getDatabase();
    const result = db.query('DELETE FROM llm_providers WHERE id = ?').run(id);
    return result.changes > 0;
  },

  /**
   * Check if a provider has an associated API key stored.
   */
  hasKey(id: string): boolean {
    const db = getDatabase();
    const row = db.query('SELECT 1 FROM llm_secrets WHERE provider_id = ?').get(id);
    return !!row;
  },
};
