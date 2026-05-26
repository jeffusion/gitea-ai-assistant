import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMasterKey } from '../../crypto/secrets';
import { closeDatabase, initDatabase } from '../../db/database';
import { providerRepo } from '../../db/repositories/provider-repo';
import type { CreateProviderInput } from '../../db/repositories/provider-repo';
import { secretRepo } from '../../db/repositories/secret-repo';
import { LLMGateway } from '../gateway';

describe('LLMGateway', () => {
  let dbPath: string;
  let gateway: LLMGateway;
  let providerId: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedEncryptionKey = process.env.ENCRYPTION_KEY;

  const providerInput: CreateProviderInput = {
    name: 'Test OpenAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  };

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `gw-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    process.env.ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'hex'
    );

    initMasterKey();
    initDatabase();

    // Create provider with key
    const created = providerRepo.create(providerInput);
    providerId = created.id;
    secretRepo.set(providerId, 'sk-test-key');

    gateway = new LLMGateway();
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    if (savedEncryptionKey === undefined) {
      Reflect.deleteProperty(process.env, 'ENCRYPTION_KEY');
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

  // ─── chatDirect: Error Cases ──────────────────────────────────────

  describe('chatDirect() — error handling', () => {
    test('throws LLMError for non-existent provider ID', async () => {
      try {
        await gateway.chatDirect('non-existent', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
        });
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.name).toBe('LLMError');
        expect(e.message).toContain('not found');
      }
    });

    test('throws LLMError when provider is disabled', async () => {
      providerRepo.update(providerId, { isEnabled: false });

      try {
        await gateway.chatDirect(providerId, {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
        });
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.name).toBe('LLMError');
        expect(e.message).toContain('disabled');
      }
    });

    test('throws LLMAuthError when no API key configured', async () => {
      secretRepo.delete(providerId);

      try {
        await gateway.chatDirect(providerId, {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
        });
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.name).toBe('LLMAuthError');
        expect(e.message).toContain('No API key');
      }
    });
  });

  // ─── Cache invalidation ──────────────────────────────────────────

  describe('cache management', () => {
    test('invalidateProvider is callable without error', () => {
      gateway.invalidateProvider(providerId);
      // No-op if not cached — should not throw
    });

    test('invalidateAll is callable without error', () => {
      gateway.invalidateAll();
    });
  });

  // ─── Provider creation/routing (integration) ─────────────────────

  describe('getProviderInstance()', () => {
    test('creates provider instance for valid config', () => {
      const instance = gateway.getProviderInstance(providerId);
      expect(instance).toBeTruthy();
      expect(instance.type).toBe('openai_compatible');
    });

    test('caches provider instance on repeated access', () => {
      const inst1 = gateway.getProviderInstance(providerId);
      const inst2 = gateway.getProviderInstance(providerId);
      expect(inst1).toBe(inst2); // Same reference
    });

    test('returns fresh instance after invalidation', () => {
      const inst1 = gateway.getProviderInstance(providerId);
      gateway.invalidateProvider(providerId);
      const inst2 = gateway.getProviderInstance(providerId);
      expect(inst1).not.toBe(inst2); // Different reference
    });

    test('creates provider for all supported types', () => {
      const types = [
        { type: 'openai_responses' as const, baseUrl: undefined },
        { type: 'anthropic' as const, baseUrl: undefined },
        { type: 'gemini' as const, baseUrl: undefined },
      ];

      for (const { type, baseUrl } of types) {
        const p = providerRepo.create({
          name: `Test ${type}`,
          type,
          baseUrl,
          defaultModel: 'test-model',
        });
        secretRepo.set(p.id, 'sk-test');

        const instance = gateway.getProviderInstance(p.id);
        expect(instance.type).toBe(type);
      }
    });
  });
});
