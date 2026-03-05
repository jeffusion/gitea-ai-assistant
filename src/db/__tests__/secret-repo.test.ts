// @ts-expect-error bun:test is provided by Bun at runtime
declare module 'bun:test' {
  export const describe: any;
  export const test: any;
  export const expect: any;
  export const beforeEach: any;
  export const afterEach: any;
}

// @ts-expect-error bun:test is provided by Bun at runtime
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMasterKey } from '../../crypto/secrets';
import { closeDatabase, initDatabase } from '../database';
import { providerRepo } from '../repositories/provider-repo';
import type { CreateProviderInput } from '../repositories/provider-repo';
import { secretRepo } from '../repositories/secret-repo';

describe('secret-repo', () => {
  let dbPath: string;
  let providerId: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedEncryptionKey = process.env.ENCRYPTION_KEY;

  const providerInput: CreateProviderInput = {
    name: 'Test Provider',
    type: 'openai_compatible',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-4o-mini',
  };

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `db-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    process.env.ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

    initMasterKey();
    initDatabase();

    const created = providerRepo.create(providerInput);
    providerId = created.id;
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    if (savedEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = savedEncryptionKey;
    }
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      /* ok */
    }
    try {
      if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    } catch {
      /* ok */
    }
    try {
      if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
    } catch {
      /* ok */
    }
  });

  // ─── Set ──────────────────────────────────────────────────────────

  describe('set()', () => {
    test('stores an encrypted API key', () => {
      secretRepo.set(providerId, 'sk-test-key-123');
      expect(secretRepo.has(providerId)).toBe(true);
    });

    test('upserts: overwrites existing key', () => {
      secretRepo.set(providerId, 'old-key');
      secretRepo.set(providerId, 'new-key');

      const retrieved = secretRepo.get(providerId);
      expect(retrieved).toBe('new-key');
    });
  });

  // ─── Get ──────────────────────────────────────────────────────────

  describe('get()', () => {
    test('returns null when no key exists', () => {
      expect(secretRepo.get(providerId)).toBeNull();
    });

    test('retrieves and decrypts the stored key', () => {
      const apiKey = 'sk-super-secret-api-key-abc123';
      secretRepo.set(providerId, apiKey);

      const retrieved = secretRepo.get(providerId);
      expect(retrieved).toBe(apiKey);
    });

    test('handles unicode API keys', () => {
      const apiKey = 'key-with-特殊字符-🔑';
      secretRepo.set(providerId, apiKey);
      expect(secretRepo.get(providerId)).toBe(apiKey);
    });

    test('returns null for non-existent provider', () => {
      expect(secretRepo.get('non-existent')).toBeNull();
    });
  });

  // ─── Has ──────────────────────────────────────────────────────────

  describe('has()', () => {
    test('returns false when no key stored', () => {
      expect(secretRepo.has(providerId)).toBe(false);
    });

    test('returns true when key is stored', () => {
      secretRepo.set(providerId, 'sk-key');
      expect(secretRepo.has(providerId)).toBe(true);
    });

    test('returns false for non-existent provider', () => {
      expect(secretRepo.has('non-existent')).toBe(false);
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────

  describe('delete()', () => {
    test('deletes existing key, returns true', () => {
      secretRepo.set(providerId, 'sk-key');
      expect(secretRepo.delete(providerId)).toBe(true);
      expect(secretRepo.has(providerId)).toBe(false);
      expect(secretRepo.get(providerId)).toBeNull();
    });

    test('returns false when no key exists', () => {
      expect(secretRepo.delete(providerId)).toBe(false);
    });
  });

  // ─── CASCADE on provider delete ───────────────────────────────────

  describe('CASCADE behavior', () => {
    test('deleting provider removes its secret', () => {
      secretRepo.set(providerId, 'sk-will-be-deleted');
      expect(secretRepo.has(providerId)).toBe(true);

      providerRepo.delete(providerId);

      expect(secretRepo.has(providerId)).toBe(false);
    });
  });

  // ─── Multiple providers ──────────────────────────────────────────

  describe('multiple providers', () => {
    test('each provider has independent key storage', () => {
      const p2 = providerRepo.create({
        ...providerInput,
        name: 'Second Provider',
        type: 'anthropic',
      });

      secretRepo.set(providerId, 'key-1');
      secretRepo.set(p2.id, 'key-2');

      expect(secretRepo.get(providerId)).toBe('key-1');
      expect(secretRepo.get(p2.id)).toBe('key-2');

      secretRepo.delete(providerId);
      expect(secretRepo.get(p2.id)).toBe('key-2');
    });
  });
});
