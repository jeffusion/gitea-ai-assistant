/**
 * AES-256-GCM encryption module for API key storage.
 *
 * Master key lifecycle:
 *   1. Read `ENCRYPTION_KEY` env var (hex-encoded, 64 hex chars = 32 bytes)
 *   2. If not set, throw — the app refuses to start without an explicit key
 *   3. Key stays in memory for process lifetime; never logged or exposed via API
 *
 * Generate a key: `openssl rand -hex 32`
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM recommended nonce size

// ---------------------------------------------------------------------------
// Master Key Management
// ---------------------------------------------------------------------------

let masterKey: Buffer | null = null;

/**
 * Initialize the master encryption key from `ENCRYPTION_KEY` env var.
 * MUST be called once at application startup before any encrypt/decrypt operations.
 *
 * @throws If ENCRYPTION_KEY is not set or has wrong length
 */
export function initMasterKey(): void {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error(
      'ENCRYPTION_KEY env var is required but not set. Generate one with: openssl rand -hex 32'
    );
  }

  const buf = Buffer.from(envKey, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY env var is ${buf.length} bytes (decoded from hex), expected ${KEY_LENGTH}. Provide exactly 64 hex characters.`
    );
  }

  masterKey = buf;
  console.log('🔑 Master key loaded from ENCRYPTION_KEY env var');
}

/**
 * Get the current master key. Throws if not initialized.
 */
function getKey(): Buffer {
  if (!masterKey) {
    throw new Error('Master key not initialized. Call initMasterKey() at startup.');
  }
  return masterKey;
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

export interface EncryptedPayload {
  /** AES-256-GCM ciphertext */
  ciphertext: Buffer;
  /** 12-byte initialization vector / nonce */
  iv: Buffer;
  /** 16-byte GCM authentication tag */
  authTag: Buffer;
}

/**
 * Encrypt a plaintext string (e.g. API key) with AES-256-GCM.
 *
 * @returns Encrypted payload containing ciphertext, IV, and auth tag
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(IV_LENGTH)));

  // Use Web Crypto–style via Node's built-in crypto
  const { createCipheriv } = require('node:crypto') as typeof import('node:crypto');
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv,
    authTag,
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload back to plaintext.
 *
 * @throws If auth tag verification fails (tampered data or wrong key)
 */
export function decrypt(payload: EncryptedPayload): string {
  const key = getKey();

  const { createDecipheriv } = require('node:crypto') as typeof import('node:crypto');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.iv);
  decipher.setAuthTag(payload.authTag);

  const decrypted = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check if the master key has been initialized.
 */
export function isMasterKeyReady(): boolean {
  return masterKey !== null;
}
