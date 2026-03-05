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

/**
 * Import a fresh secrets module to bypass module cache (same pattern as config-manager.test.ts).
 * Each import gets its own masterKey singleton.
 */
async function importFresh() {
  return await import(`../../crypto/secrets.ts?t=${Date.now()}-${randomUUID()}`);
}

/** Generate a valid 64-char hex key for tests */
function generateHexKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
}

describe('secrets — AES-256-GCM encryption', () => {
  let savedEncryptionKey: string | undefined;

  beforeEach(() => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (savedEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = savedEncryptionKey;
    }
  });

  // ─── Master Key Init ─────────────────────────────────────────────────

  describe('initMasterKey()', () => {
    test('loads key from ENCRYPTION_KEY env var (hex)', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();

      const secrets = await importFresh();
      secrets.initMasterKey();

      expect(secrets.isMasterKeyReady()).toBe(true);
    });

    test('throws if ENCRYPTION_KEY is not set', async () => {
      delete process.env.ENCRYPTION_KEY;

      const secrets = await importFresh();
      expect(() => secrets.initMasterKey()).toThrow('ENCRYPTION_KEY env var is required');
    });

    test('throws if ENCRYPTION_KEY is wrong length', async () => {
      process.env.ENCRYPTION_KEY = 'abcd'; // Only 2 bytes

      const secrets = await importFresh();
      expect(() => secrets.initMasterKey()).toThrow('2 bytes');
    });

    test('throws if ENCRYPTION_KEY is empty string', async () => {
      process.env.ENCRYPTION_KEY = '';

      const secrets = await importFresh();
      expect(() => secrets.initMasterKey()).toThrow('ENCRYPTION_KEY env var is required');
    });
  });

  // ─── isMasterKeyReady ────────────────────────────────────────────────

  describe('isMasterKeyReady()', () => {
    test('returns false before initMasterKey', async () => {
      const secrets = await importFresh();
      expect(secrets.isMasterKeyReady()).toBe(false);
    });

    test('returns true after initMasterKey', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
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
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const plaintext = 'sk-abc123-super-secret-api-key';
      const encrypted = secrets.encrypt(plaintext);
      const decrypted = secrets.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    test('encrypts empty string', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('');
      expect(secrets.decrypt(encrypted)).toBe('');
    });

    test('encrypts unicode content', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const unicode = '密钥🔑テスト키';
      const encrypted = secrets.encrypt(unicode);
      expect(secrets.decrypt(encrypted)).toBe(unicode);
    });

    test('encrypts long content', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const long = 'A'.repeat(10000);
      const encrypted = secrets.encrypt(long);
      expect(secrets.decrypt(encrypted)).toBe(long);
    });

    test('each encryption produces unique IV (different ciphertext)', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
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
      process.env.ENCRYPTION_KEY = generateHexKey();
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
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('secret');
      // Tamper with ciphertext
      encrypted.ciphertext[0] ^= 0xff;

      expect(() => secrets.decrypt(encrypted)).toThrow();
    });

    test('tampered auth tag fails decryption', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets = await importFresh();
      secrets.initMasterKey();

      const encrypted = secrets.encrypt('secret');
      encrypted.authTag[0] ^= 0xff;

      expect(() => secrets.decrypt(encrypted)).toThrow();
    });

    test('wrong master key fails decryption', async () => {
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets1 = await importFresh();
      secrets1.initMasterKey();
      const encrypted = secrets1.encrypt('secret');

      // Use a different key
      process.env.ENCRYPTION_KEY = generateHexKey();
      const secrets2 = await importFresh();
      secrets2.initMasterKey();

      expect(() => secrets2.decrypt(encrypted)).toThrow();
    });
  });
});
