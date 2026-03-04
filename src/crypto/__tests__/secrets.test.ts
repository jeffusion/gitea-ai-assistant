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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Import a fresh secrets module to bypass module cache (same pattern as config-manager.test.ts).
 * Each import gets its own masterKey singleton.
 */
async function importFresh() {
  return await import(`../../crypto/secrets.ts?t=${Date.now()}-${randomUUID()}`);
}

describe('secrets — AES-256-GCM encryption', () => {
  let tmpDir: string;
  let keyPath: string;
  const savedMasterKeyPath = process.env.MASTER_KEY_PATH;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `secrets-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    keyPath = join(tmpDir, 'master.key');
    process.env.MASTER_KEY_PATH = keyPath;
  });

  afterEach(() => {
    if (savedMasterKeyPath === undefined) {
      delete process.env.MASTER_KEY_PATH;
    } else {
      process.env.MASTER_KEY_PATH = savedMasterKeyPath;
    }
    // Cleanup temp files
    try {
      if (existsSync(keyPath)) unlinkSync(keyPath);
    } catch {
      /* ok */
    }
  });

  // ─── Master Key Init ─────────────────────────────────────────────────

  describe('initMasterKey()', () => {
    test('generates a new 32-byte key file when none exists', async () => {
      const secrets = await importFresh();
      expect(existsSync(keyPath)).toBe(false);

      secrets.initMasterKey();

      expect(existsSync(keyPath)).toBe(true);
      const raw = readFileSync(keyPath);
      expect(raw.length).toBe(32);
      expect(secrets.isMasterKeyReady()).toBe(true);
    });

    test('loads an existing key file without overwriting', async () => {
      // Pre-create a 32-byte key
      const existingKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
      writeFileSync(keyPath, existingKey, { mode: 0o600 });

      const secrets = await importFresh();
      secrets.initMasterKey();

      const loaded = readFileSync(keyPath);
      expect(Buffer.compare(loaded, existingKey)).toBe(0);
      expect(secrets.isMasterKeyReady()).toBe(true);
    });

    test('throws if key file is wrong length', async () => {
      writeFileSync(keyPath, Buffer.alloc(16)); // Wrong length

      const secrets = await importFresh();
      expect(() => secrets.initMasterKey()).toThrow('16 bytes, expected 32');
    });

    test('creates parent directories if needed', async () => {
      const nestedPath = join(tmpDir, 'nested', 'deep', 'master.key');
      process.env.MASTER_KEY_PATH = nestedPath;

      const secrets = await importFresh();
      secrets.initMasterKey();

      expect(existsSync(nestedPath)).toBe(true);
      expect(readFileSync(nestedPath).length).toBe(32);
    });
  });

  // ─── isMasterKeyReady ────────────────────────────────────────────────

  describe('isMasterKeyReady()', () => {
    test('returns false before initMasterKey', async () => {
      const secrets = await importFresh();
      expect(secrets.isMasterKeyReady()).toBe(false);
    });

    test('returns true after initMasterKey', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();
      expect(secrets.isMasterKeyReady()).toBe(true);
    });
  });

  // ─── Encrypt / Decrypt ──────────────────────────────────────────────

  describe('encrypt() / decrypt()', () => {
    test('throws when master key not initialized', async () => {
      const secrets = await importFresh();
      expect(() => secrets.encrypt('test')).toThrow('Master key not initialized');
    });

    test('roundtrip: encrypt then decrypt recovers plaintext', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const plaintext = 'sk-abc123-super-secret-api-key';
      const encrypted = secrets.encrypt(plaintext);
      const decrypted = secrets.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    test('encrypts empty string', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('');
      expect(secrets.decrypt(encrypted)).toBe('');
    });

    test('encrypts unicode content', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const unicode = '密钥🔑テスト키';
      const encrypted = secrets.encrypt(unicode);
      expect(secrets.decrypt(encrypted)).toBe(unicode);
    });

    test('encrypts long content', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const long = 'A'.repeat(10000);
      const encrypted = secrets.encrypt(long);
      expect(secrets.decrypt(encrypted)).toBe(long);
    });

    test('each encryption produces unique IV (different ciphertext)', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const plaintext = 'same-content';
      const enc1 = secrets.encrypt(plaintext);
      const enc2 = secrets.encrypt(plaintext);

      // IVs should differ
      expect(Buffer.compare(enc1.iv, enc2.iv)).not.toBe(0);
      // Both decrypt to same plaintext
      expect(secrets.decrypt(enc1)).toBe(plaintext);
      expect(secrets.decrypt(enc2)).toBe(plaintext);
    });

    test('encrypted payload has expected structure', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('test');

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
      expect(Buffer.isBuffer(encrypted.ciphertext)).toBe(true);
      expect(Buffer.isBuffer(encrypted.iv)).toBe(true);
      expect(Buffer.isBuffer(encrypted.authTag)).toBe(true);
      expect(encrypted.iv.length).toBe(12); // GCM nonce
      expect(encrypted.authTag.length).toBe(16); // GCM tag
    });

    test('tampered ciphertext fails decryption', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('secret');
      // Tamper with ciphertext
      encrypted.ciphertext[0] ^= 0xff;

      expect(() => secrets.decrypt(encrypted)).toThrow();
    });

    test('tampered auth tag fails decryption', async () => {
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('secret');
      encrypted.authTag[0] ^= 0xff;

      expect(() => secrets.decrypt(encrypted)).toThrow();
    });

    test('wrong master key fails decryption', async () => {
      const secrets1 = await importFresh();
      secrets1.initMasterKey();
      const encrypted = secrets1.encrypt('secret');

      // Create a different key
      unlinkSync(keyPath);
      const secrets2 = await importFresh();
      secrets2.initMasterKey(); // Generates a new key

      expect(() => secrets2.decrypt(encrypted)).toThrow();
    });
  });
});
