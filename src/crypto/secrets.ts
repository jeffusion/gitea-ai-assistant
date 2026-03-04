/**
 * AES-256-GCM encryption module for API key storage.
 *
 * Master key lifecycle:
 *   1. On first startup, generate 32 random bytes → write to DATA_DIR/master.key (chmod 600)
 *   2. On subsequent startups, read existing master.key
 *   3. Key stays in memory for process lifetime; never logged or exposed via API
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 * Resolve the master key file path.
 * Defaults to `data/master.key` relative to CWD, overridable via `MASTER_KEY_PATH` env.
 */
function getMasterKeyPath(): string {
  return resolve(process.env.MASTER_KEY_PATH || './data/master.key');
}

/**
 * Initialize (load or generate) the master encryption key.
 * MUST be called once at application startup before any encrypt/decrypt operations.
 */
export function initMasterKey(): void {
  const keyPath = getMasterKeyPath();

  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length !== KEY_LENGTH) {
      throw new Error(
        `Master key at ${keyPath} is ${raw.length} bytes, expected ${KEY_LENGTH}. Delete the file and restart to generate a new key (all encrypted API keys will need to be re-entered).`
      );
    }
    masterKey = Buffer.from(raw);
    console.log(`🔑 Master key loaded from ${keyPath}`);
  } else {
    const dir = dirname(keyPath);
    mkdirSync(dir, { recursive: true });

    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_LENGTH)));
    writeFileSync(keyPath, key, { mode: 0o600 });

    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // chmod may fail on some filesystems (e.g. Windows); non-fatal
    }

    masterKey = key;
    console.log(`🔑 Generated new master key at ${keyPath}`);
  }
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
