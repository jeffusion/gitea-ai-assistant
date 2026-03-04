/**
 * Repository for system_settings table.
 * Generic key-value store for non-LLM configuration.
 * Sensitive values are encrypted using the same crypto module as API keys.
 */

import { type EncryptedPayload, decrypt, encrypt } from '../../crypto/secrets';
import { getDatabase } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingRow {
  key: string;
  value: string;
  is_sensitive: number; // 0 or 1
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const settingsRepo = {
  /**
   * Get a setting value by key. Automatically decrypts sensitive values.
   * Returns null if not found.
   */
  get(key: string): string | null {
    const db = getDatabase();
    const row = db
      .query('SELECT value, is_sensitive FROM system_settings WHERE key = ?')
      .get(key) as Pick<SettingRow, 'value' | 'is_sensitive'> | null;

    if (!row) return null;

    if (row.is_sensitive) {
      try {
        const parsed = JSON.parse(row.value) as {
          ciphertext: string;
          iv: string;
          authTag: string;
        };
        const payload: EncryptedPayload = {
          ciphertext: Buffer.from(parsed.ciphertext, 'base64'),
          iv: Buffer.from(parsed.iv, 'base64'),
          authTag: Buffer.from(parsed.authTag, 'base64'),
        };
        return decrypt(payload);
      } catch {
        // If decryption fails (e.g. master key changed), return null
        return null;
      }
    }

    return row.value;
  },

  /**
   * Set a key-value pair. Encrypts the value if sensitive=true.
   */
  set(key: string, value: string, sensitive = false): void {
    const db = getDatabase();

    let storedValue = value;
    if (sensitive) {
      const payload = encrypt(value);
      storedValue = JSON.stringify({
        ciphertext: payload.ciphertext.toString('base64'),
        iv: payload.iv.toString('base64'),
        authTag: payload.authTag.toString('base64'),
      });
    }

    db.query(
      `INSERT INTO system_settings (key, value, is_sensitive, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         is_sensitive = excluded.is_sensitive,
         updated_at = datetime('now')`
    ).run(key, storedValue, sensitive ? 1 : 0);
  },

  /**
   * Delete a setting.
   */
  delete(key: string): boolean {
    const db = getDatabase();
    const result = db.query('DELETE FROM system_settings WHERE key = ?').run(key);
    return result.changes > 0;
  },

  /**
   * List all settings. Sensitive values are masked as '••••••••'.
   */
  listAll(): Array<{ key: string; value: string; isSensitive: boolean; updatedAt: string }> {
    const db = getDatabase();
    const rows = db.query('SELECT * FROM system_settings ORDER BY key').all() as SettingRow[];

    return rows.map((row) => ({
      key: row.key,
      value: row.is_sensitive ? '••••••••' : row.value,
      isSensitive: row.is_sensitive === 1,
      updatedAt: row.updated_at,
    }));
  },

  /**
   * Batch update multiple settings at once.
   */
  setMany(entries: Array<{ key: string; value: string; sensitive?: boolean }>): void {
    const db = getDatabase();
    db.transaction(() => {
      for (const entry of entries) {
        this.set(entry.key, entry.value, entry.sensitive);
      }
    })();
  },
};
