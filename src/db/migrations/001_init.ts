/**
 * Migration 001: Initial schema for pluggable LLM provider architecture.
 *
 * Creates tables:
 *   - llm_providers: Provider instance configuration
 *   - llm_secrets: Encrypted API key storage
 *   - model_role_assignments: Business role → provider+model mapping
 *   - system_settings: Generic KV settings store
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration001Init: Migration = {
  version: 1,
  name: 'init_llm_provider_schema',

  up(db: Database): void {
    // ── Table 1: llm_providers ──────────────────────────────────────────
    db.exec(`
      CREATE TABLE llm_providers (
        id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK (type IN (
                        'openai_compatible',
                        'openai_responses',
                        'anthropic',
                        'gemini'
                      )),
        base_url      TEXT,
        default_model TEXT NOT NULL,
        is_enabled    INTEGER NOT NULL DEFAULT 1,
        extra_config  TEXT DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── Table 2: llm_secrets ────────────────────────────────────────────
    db.exec(`
      CREATE TABLE llm_secrets (
        provider_id   TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
        ciphertext    BLOB NOT NULL,
        iv            BLOB NOT NULL,
        auth_tag      BLOB NOT NULL,
        key_version   INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── Table 3: model_role_assignments ─────────────────────────────────
    db.exec(`
      CREATE TABLE model_role_assignments (
        role          TEXT PRIMARY KEY CHECK (role IN (
                        'planner',
                        'specialist',
                        'judge',
                        'embedding'
                      )),
        provider_id   TEXT NOT NULL REFERENCES llm_providers(id),
        model         TEXT NOT NULL,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── Table 4: system_settings ────────────────────────────────────────
    db.exec(`
      CREATE TABLE system_settings (
        key           TEXT PRIMARY KEY,
        value         TEXT NOT NULL,
        is_sensitive  INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── Indexes ─────────────────────────────────────────────────────────
    db.exec('CREATE INDEX idx_providers_type ON llm_providers(type)');
    db.exec('CREATE INDEX idx_providers_enabled ON llm_providers(is_enabled)');
  },
};
