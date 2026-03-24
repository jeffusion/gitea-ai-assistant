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
import { closeDatabase, initDatabase } from '../database';
import { providerRepo } from '../repositories/provider-repo';
import type { CreateProviderInput } from '../repositories/provider-repo';

describe('provider-repo', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `db-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
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

  const sampleInput: CreateProviderInput = {
    name: 'Test OpenAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    extraConfig: { org: 'test-org' },
  };

  // ─── Create ────────────────────────────────────────────────────────

  describe('create()', () => {
    test('creates a provider and returns it with auto-generated ID', () => {
      const created = providerRepo.create(sampleInput);

      expect(created.id).toBeTruthy();
      expect(typeof created.id).toBe('string');
      expect(created.name).toBe('Test OpenAI');
      expect(created.type).toBe('openai_compatible');
      expect(created.base_url).toBe('https://api.openai.com/v1');
      expect(created.default_model).toBe('gpt-4o-mini');
      expect(created.is_enabled).toBe(1);
      expect(JSON.parse(created.extra_config)).toEqual({ org: 'test-org' });
      expect(created.created_at).toBeTruthy();
      expect(created.updated_at).toBeTruthy();
    });

    test('creates provider with null baseUrl', () => {
      const input: CreateProviderInput = {
        name: 'Anthropic',
        type: 'anthropic',
        defaultModel: 'claude-3-5-sonnet-20241022',
      };
      const created = providerRepo.create(input);
      expect(created.base_url).toBeNull();
    });

    test('creates provider with default empty extraConfig', () => {
      const input: CreateProviderInput = {
        name: 'Gemini',
        type: 'gemini',
        defaultModel: 'gemini-pro',
      };
      const created = providerRepo.create(input);
      expect(JSON.parse(created.extra_config)).toEqual({});
    });

    test('each create generates unique IDs', () => {
      const p1 = providerRepo.create({ ...sampleInput, name: 'Provider 1' });
      const p2 = providerRepo.create({ ...sampleInput, name: 'Provider 2' });
      expect(p1.id).not.toBe(p2.id);
    });
  });

  // ─── List ──────────────────────────────────────────────────────────

  describe('list()', () => {
    test('returns empty array when no providers exist', () => {
      expect(providerRepo.list()).toEqual([]);
    });

    test('returns all providers ordered by created_at', () => {
      providerRepo.create({ ...sampleInput, name: 'First' });
      providerRepo.create({ ...sampleInput, name: 'Second' });
      providerRepo.create({ ...sampleInput, name: 'Third' });

      const all = providerRepo.list();
      expect(all).toHaveLength(3);
      expect(all[0].name).toBe('First');
      expect(all[2].name).toBe('Third');
    });

    test('enabledOnly=true filters disabled providers', () => {
      providerRepo.create({ ...sampleInput, name: 'Enabled' });
      const p2 = providerRepo.create({ ...sampleInput, name: 'Disabled' });
      providerRepo.update(p2.id, { isEnabled: false });

      const enabled = providerRepo.list(true);
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('Enabled');
    });
  });

  // ─── GetById ───────────────────────────────────────────────────────

  describe('getById()', () => {
    test('returns provider by ID', () => {
      const created = providerRepo.create(sampleInput);
      const fetched = providerRepo.getById(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe(created.name);
    });

    test('returns null for non-existent ID', () => {
      expect(providerRepo.getById('non-existent')).toBeNull();
    });
  });

  // ─── Update ────────────────────────────────────────────────────────

  describe('update()', () => {
    test('updates name only', () => {
      const created = providerRepo.create(sampleInput);
      const updated = providerRepo.update(created.id, { name: 'Updated Name' });

      expect(updated!.name).toBe('Updated Name');
      expect(updated!.type).toBe(created.type);
      expect(updated!.default_model).toBe(created.default_model);
    });

    test('updates multiple fields at once', () => {
      const created = providerRepo.create(sampleInput);
      const updated = providerRepo.update(created.id, {
        name: 'New Name',
        defaultModel: 'gpt-4o',
        isEnabled: false,
        baseUrl: 'https://new-url.com',
        extraConfig: { newKey: 'newVal' },
      });

      expect(updated!.name).toBe('New Name');
      expect(updated!.default_model).toBe('gpt-4o');
      expect(updated!.is_enabled).toBe(0);
      expect(updated!.base_url).toBe('https://new-url.com');
      expect(JSON.parse(updated!.extra_config)).toEqual({ newKey: 'newVal' });
    });

    test('returns null for non-existent ID', () => {
      expect(providerRepo.update('non-existent', { name: 'x' })).toBeNull();
    });

    test('returns existing row when no fields provided', () => {
      const created = providerRepo.create(sampleInput);
      const updated = providerRepo.update(created.id, {});
      expect(updated!.name).toBe(created.name);
    });

    test('updates updated_at timestamp', () => {
      const created = providerRepo.create(sampleInput);
      const updated = providerRepo.update(created.id, { name: 'Changed' });
      expect(updated!.updated_at).toBeTruthy();
    });
  });

  // ─── Delete ────────────────────────────────────────────────────────

  describe('delete()', () => {
    test('deletes existing provider, returns true', () => {
      const created = providerRepo.create(sampleInput);
      expect(providerRepo.delete(created.id)).toBe(true);
      expect(providerRepo.getById(created.id)).toBeNull();
    });

    test('returns false for non-existent ID', () => {
      expect(providerRepo.delete('non-existent')).toBe(false);
    });

    test('deleting provider does not affect other providers', () => {
      providerRepo.create({ ...sampleInput, name: 'Keep' });
      const p2 = providerRepo.create({ ...sampleInput, name: 'Delete' });

      providerRepo.delete(p2.id);

      expect(providerRepo.list()).toHaveLength(1);
      expect(providerRepo.list()[0].name).toBe('Keep');
    });
  });

  // ─── hasKey ────────────────────────────────────────────────────────

  describe('hasKey()', () => {
    test('returns false when no secret exists', () => {
      const created = providerRepo.create(sampleInput);
      expect(providerRepo.hasKey(created.id)).toBe(false);
    });
  });
});
