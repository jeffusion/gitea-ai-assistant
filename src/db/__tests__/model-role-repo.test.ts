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
import { modelRoleRepo } from '../repositories/model-role-repo';
import type { ModelRole } from '../repositories/model-role-repo';
import { providerRepo } from '../repositories/provider-repo';
import type { CreateProviderInput } from '../repositories/provider-repo';

describe('model-role-repo', () => {
  let dbPath: string;
  let providerId: string;
  const savedDbPath = process.env.DATABASE_PATH;

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

  // ─── Set (upsert) ─────────────────────────────────────────────────

  describe('set()', () => {
    test('creates a new role assignment', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');

      const assignment = modelRoleRepo.getByRole('legacy');
      expect(assignment).not.toBeNull();
      expect(assignment!.role).toBe('legacy');
      expect(assignment!.provider_id).toBe(providerId);
      expect(assignment!.model).toBe('gpt-4o-mini');
    });

    test('upserts: updates existing role assignment', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      modelRoleRepo.set('legacy', providerId, 'gpt-4o');

      const assignment = modelRoleRepo.getByRole('legacy');
      expect(assignment!.model).toBe('gpt-4o');
    });

    test('can assign different roles', () => {
      const roles: ModelRole[] = ['legacy', 'planner', 'specialist', 'judge', 'embedding'];
      for (const role of roles) {
        modelRoleRepo.set(role, providerId, `model-for-${role}`);
      }

      for (const role of roles) {
        const a = modelRoleRepo.getByRole(role);
        expect(a!.model).toBe(`model-for-${role}`);
      }
    });
  });

  // ─── GetByRole ────────────────────────────────────────────────────

  describe('getByRole()', () => {
    test('returns null when no assignment exists', () => {
      expect(modelRoleRepo.getByRole('legacy')).toBeNull();
    });

    test('returns the correct assignment', () => {
      modelRoleRepo.set('planner', providerId, 'gpt-4o');
      const a = modelRoleRepo.getByRole('planner');
      expect(a!.provider_id).toBe(providerId);
      expect(a!.model).toBe('gpt-4o');
    });
  });

  // ─── List ─────────────────────────────────────────────────────────

  describe('list()', () => {
    test('returns empty array when no assignments exist', () => {
      expect(modelRoleRepo.list()).toEqual([]);
    });

    test('returns all assignments with provider info (JOIN)', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      modelRoleRepo.set('planner', providerId, 'gpt-4o');

      const all = modelRoleRepo.list();
      expect(all).toHaveLength(2);

      expect(all[0].provider_name).toBe('Test Provider');
      expect(all[0].provider_type).toBe('openai_compatible');
    });

    test('results are ordered by role', () => {
      modelRoleRepo.set('specialist', providerId, 'model-a');
      modelRoleRepo.set('embedding', providerId, 'model-b');
      modelRoleRepo.set('legacy', providerId, 'model-c');

      const all = modelRoleRepo.list();
      const roles = all.map((a) => a.role);
      expect(roles).toEqual([...roles].sort());
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────

  describe('delete()', () => {
    test('deletes existing assignment, returns true', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      expect(modelRoleRepo.delete('legacy')).toBe(true);
      expect(modelRoleRepo.getByRole('legacy')).toBeNull();
    });

    test('returns false for non-existent role', () => {
      expect(modelRoleRepo.delete('legacy')).toBe(false);
    });
  });

  // ─── GetRolesByProvider ───────────────────────────────────────────

  describe('getRolesByProvider()', () => {
    test('returns empty array when no roles assigned', () => {
      expect(modelRoleRepo.getRolesByProvider(providerId)).toEqual([]);
    });

    test('returns all roles assigned to a provider', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      modelRoleRepo.set('planner', providerId, 'gpt-4o');
      modelRoleRepo.set('judge', providerId, 'gpt-4o');

      const roles = modelRoleRepo.getRolesByProvider(providerId);
      expect(roles).toHaveLength(3);
      expect(roles).toContain('legacy');
      expect(roles).toContain('planner');
      expect(roles).toContain('judge');
    });

    test('does not return roles assigned to other providers', () => {
      const p2 = providerRepo.create({
        ...providerInput,
        name: 'Other Provider',
        type: 'anthropic',
      });
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      modelRoleRepo.set('planner', p2.id, 'claude-3-5-sonnet');

      const roles1 = modelRoleRepo.getRolesByProvider(providerId);
      expect(roles1).toEqual(['legacy']);

      const roles2 = modelRoleRepo.getRolesByProvider(p2.id);
      expect(roles2).toEqual(['planner']);
    });
  });

  // ─── CASCADE on provider delete ───────────────────────────────────

  describe('foreign key constraint', () => {
    test('cannot delete provider while role assignments exist (no CASCADE)', () => {
      modelRoleRepo.set('legacy', providerId, 'gpt-4o-mini');
      modelRoleRepo.set('planner', providerId, 'gpt-4o');

      // FK constraint prevents delete — must remove assignments first
      expect(() => providerRepo.delete(providerId)).toThrow();

      // Clean up assignments first, then delete succeeds
      modelRoleRepo.delete('legacy');
      modelRoleRepo.delete('planner');
      expect(providerRepo.delete(providerId)).toBe(true);
    });
  });
});
