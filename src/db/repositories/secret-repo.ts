/**
 * Repository for llm_secrets table.
 * Encrypted API key storage using AES-256-GCM.
 */

import { type EncryptedPayload, decrypt, encrypt } from '../../crypto/secrets';
import { getDatabase } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecretRow {
  provider_id: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const secretRepo = {
  /**
   * Store (or replace) an encrypted API key for a provider.
   */
  set(providerId: string, apiKey: string): void {
    const db = getDatabase();
    const payload = encrypt(apiKey);

    db.query(
      `INSERT INTO llm_secrets (provider_id, ciphertext, iv, auth_tag, key_version, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         key_version = excluded.key_version,
         updated_at = datetime('now')`
    ).run(providerId, payload.ciphertext, payload.iv, payload.authTag);
  },

  /**
   * Retrieve and decrypt the API key for a provider.
   * Returns null if no key is stored.
   */
  get(providerId: string): string | null {
    const db = getDatabase();
    const row = db
      .query('SELECT ciphertext, iv, auth_tag FROM llm_secrets WHERE provider_id = ?')
      .get(providerId) as SecretRow | null;

    if (!row) return null;

    const payload: EncryptedPayload = {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.auth_tag),
    };

    return decrypt(payload);
  },

  /**
   * Check if a provider has a stored API key.
   */
  has(providerId: string): boolean {
    const db = getDatabase();
    const row = db.query('SELECT 1 FROM llm_secrets WHERE provider_id = ?').get(providerId);
    return !!row;
  },

  /**
   * Remove the API key for a provider.
   */
  delete(providerId: string): boolean {
    const db = getDatabase();
    const result = db.query('DELETE FROM llm_secrets WHERE provider_id = ?').run(providerId);
    return result.changes > 0;
  },
};
