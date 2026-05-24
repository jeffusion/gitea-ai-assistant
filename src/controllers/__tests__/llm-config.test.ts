import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { initMasterKey } from '../../crypto/secrets';
import { closeDatabase, initDatabase } from '../../db/database';
import { modelRoleRepo } from '../../db/repositories/model-role-repo';
import { providerRepo } from '../../db/repositories/provider-repo';
import { secretRepo } from '../../db/repositories/secret-repo';
import { llmConfigRouter } from '../llm-config';

/**
 * Create a test Hono app with the LLM config router mounted.
 */
function createTestApp(): Hono {
  const app = new Hono();
  app.route('/llm', llmConfigRouter);
  return app;
}

/**
 * Helper to make JSON requests to the test app.
 */
async function jsonRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(`http://localhost/llm${path}`, init);
  // Handle non-JSON responses (e.g. 500 errors that return HTML)
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return { status: res.status, data };
  } catch {
    return { status: res.status, data: { _raw: text } };
  }
}

describe('llm-config controller', () => {
  let dbPath: string;
  let app: Hono;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `ctrl-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    process.env.ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'hex'
    );

    initMasterKey();
    initDatabase();
    app = createTestApp();
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

  // ─── Provider CRUD ────────────────────────────────────────────────

  describe('GET /providers', () => {
    test('returns empty array when no providers', async () => {
      const { status, data } = await jsonRequest(app, 'GET', '/providers');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    test('returns all providers with formatted fields', async () => {
      providerRepo.create({
        name: 'Test',
        type: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1',
        defaultModel: 'gpt-4o-mini',
      });

      const { status, data } = await jsonRequest(app, 'GET', '/providers');
      expect(status).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0]).toHaveProperty('id');
      expect(data[0].name).toBe('Test');
      expect(data[0].isEnabled).toBe(true);
      expect(data[0].hasKey).toBe(false);
    });
  });

  describe('POST /providers', () => {
    test('creates a provider successfully', async () => {
      const { status, data } = await jsonRequest(app, 'POST', '/providers', {
        name: 'New Provider',
        type: 'anthropic',
        defaultModel: 'claude-3-5-sonnet-20241022',
      });

      expect(status).toBe(201);
      expect(data.name).toBe('New Provider');
      expect(data.type).toBe('anthropic');
      expect(data.defaultModel).toBe('claude-3-5-sonnet-20241022');
      expect(data.isEnabled).toBe(true);
    });

    test('creates provider with API key', async () => {
      const { status, data } = await jsonRequest(app, 'POST', '/providers', {
        name: 'With Key',
        type: 'openai_responses',
        defaultModel: 'gpt-4o',
        apiKey: 'sk-test-123',
      });

      expect(status).toBe(201);
      expect(data.hasKey).toBe(true);
    });

    test('auto-binds all roles when first provider is created', async () => {
      await jsonRequest(app, 'POST', '/providers', {
        name: 'First Provider',
        type: 'gemini',
        defaultModel: 'gemini-pro',
        apiKey: 'test-key',
      });

      const { data: roles } = await jsonRequest(app, 'GET', '/roles');
      const assignedRoles = roles.filter((r: any) => r.providerId !== null);
      expect(assignedRoles).toHaveLength(2);
    });

    test('rejects missing required fields', async () => {
      const { status, data } = await jsonRequest(app, 'POST', '/providers', {
        name: 'Missing Type',
      });
      expect(status).toBe(400);
      expect(data.message).toContain('Missing required fields');
    });

    test('rejects invalid provider type', async () => {
      const { status, data } = await jsonRequest(app, 'POST', '/providers', {
        name: 'Bad Type',
        type: 'invalid_type',
        defaultModel: 'model',
      });
      expect(status).toBe(400);
      expect(data.message).toContain('Invalid type');
    });

    test('requires baseUrl for openai_compatible', async () => {
      const { status, data } = await jsonRequest(app, 'POST', '/providers', {
        name: 'No URL',
        type: 'openai_compatible',
        defaultModel: 'model',
      });
      expect(status).toBe(400);
      expect(data.message).toContain('baseUrl is required');
    });
  });

  describe('GET /providers/:id', () => {
    test('returns provider by ID', async () => {
      const created = providerRepo.create({
        name: 'FindMe',
        type: 'gemini',
        defaultModel: 'gemini-pro',
      });

      const { status, data } = await jsonRequest(app, 'GET', `/providers/${created.id}`);
      expect(status).toBe(200);
      expect(data.name).toBe('FindMe');
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'GET', '/providers/non-existent');
      expect(status).toBe(404);
    });
  });

  describe('PUT /providers/:id', () => {
    test('updates provider fields', async () => {
      const created = providerRepo.create({
        name: 'Original',
        type: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1',
        defaultModel: 'gpt-4o-mini',
      });

      const { status, data } = await jsonRequest(app, 'PUT', `/providers/${created.id}`, {
        name: 'Updated',
        defaultModel: 'gpt-4o',
      });

      expect(status).toBe(200);
      expect(data.name).toBe('Updated');
      expect(data.defaultModel).toBe('gpt-4o');
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'PUT', '/providers/non-existent', {
        name: 'x',
      });
      expect(status).toBe(404);
    });
  });

  describe('DELETE /providers/:id', () => {
    test('deletes provider without role assignments', async () => {
      const created = providerRepo.create({
        name: 'ToDelete',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });

      const { status, data } = await jsonRequest(app, 'DELETE', `/providers/${created.id}`);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.removedRoleAssignments).toEqual([]);
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'DELETE', '/providers/non-existent');
      expect(status).toBe(404);
    });
  });

  // ─── API Key Management ──────────────────────────────────────────

  describe('PUT /providers/:id/key', () => {
    test('sets API key for provider', async () => {
      const created = providerRepo.create({
        name: 'NeedsKey',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });

      const { status, data } = await jsonRequest(app, 'PUT', `/providers/${created.id}/key`, {
        apiKey: 'sk-new-key',
      });
      expect(status).toBe(200);
      expect(data.success).toBe(true);

      // Verify key is stored
      expect(secretRepo.has(created.id)).toBe(true);
      expect(secretRepo.get(created.id)).toBe('sk-new-key');
    });

    test('returns 400 when apiKey is missing', async () => {
      const created = providerRepo.create({
        name: 'Test',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });

      const { status, data } = await jsonRequest(app, 'PUT', `/providers/${created.id}/key`, {});
      expect(status).toBe(400);
      expect(data.message).toContain('apiKey is required');
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'PUT', '/providers/non-existent/key', {
        apiKey: 'sk-test',
      });
      expect(status).toBe(404);
    });
  });

  describe('DELETE /providers/:id/key', () => {
    test('deletes API key', async () => {
      const created = providerRepo.create({
        name: 'HasKey',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });
      secretRepo.set(created.id, 'sk-key');

      const { status, data } = await jsonRequest(app, 'DELETE', `/providers/${created.id}/key`);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(secretRepo.has(created.id)).toBe(false);
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'DELETE', '/providers/non-existent/key');
      expect(status).toBe(404);
    });
  });

  // ─── Role Assignments ────────────────────────────────────────────

  describe('GET /roles', () => {
    test('returns all MODEL_ROLES with null assignments when unassigned', async () => {
      const { status, data } = await jsonRequest(app, 'GET', '/roles');
      expect(status).toBe(200);
      expect(data).toHaveLength(2);
      expect(data[0]).toHaveProperty('role');
      expect(data[0]).toHaveProperty('providerId');
    });

    test('returns assigned role info when set', async () => {
      const provider = providerRepo.create({
        name: 'RoleTest',
        type: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1',
        defaultModel: 'gpt-4o-mini',
      });
      modelRoleRepo.set('planner', provider.id, 'gpt-4o');

      const { data } = await jsonRequest(app, 'GET', '/roles');
      const planner = data.find((r: any) => r.role === 'planner');
      expect(planner.providerId).toBe(provider.id);
      expect(planner.providerName).toBe('RoleTest');
      expect(planner.model).toBe('gpt-4o');
    });
  });

  describe('PUT /roles/:role', () => {
    test('assigns a role to a provider+model', async () => {
      const provider = providerRepo.create({
        name: 'AssignTarget',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });

      const { status, data } = await jsonRequest(app, 'PUT', '/roles/planner', {
        providerId: provider.id,
        model: 'claude-3-5-sonnet',
      });

      expect(status).toBe(200);
      expect(data.role).toBe('planner');
      expect(data.providerId).toBe(provider.id);
      expect(data.model).toBe('claude-3-5-sonnet');
    });

    test('rejects invalid role name', async () => {
      const { status, data } = await jsonRequest(app, 'PUT', '/roles/invalid_role', {
        providerId: 'some-id',
        model: 'model',
      });
      expect(status).toBe(400);
      expect(data.message).toContain('Invalid role');
    });

    test('rejects missing providerId or model', async () => {
      const { status, data } = await jsonRequest(app, 'PUT', '/roles/planner', {
        providerId: 'some-id',
      });
      expect(status).toBe(400);
      expect(data.message).toContain('providerId and model are required');
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'PUT', '/roles/planner', {
        providerId: 'non-existent',
        model: 'model',
      });
      expect(status).toBe(404);
    });
  });

  // ─── Connection Test ─────────────────────────────────────────────

  describe('POST /providers/:id/test', () => {
    test('returns error when no API key configured', async () => {
      const provider = providerRepo.create({
        name: 'NoKey',
        type: 'anthropic',
        defaultModel: 'claude-3',
      });

      const { status, data } = await jsonRequest(app, 'POST', `/providers/${provider.id}/test`);
      expect(status).toBe(200);
      expect(data.success).toBe(false);
      expect(data.error).toContain('No API key');
    });

    test('returns 404 for non-existent provider', async () => {
      const { status } = await jsonRequest(app, 'POST', '/providers/non-existent/test');
      expect(status).toBe(404);
    });
  });

  // ─── System Settings ─────────────────────────────────────────────

  describe('GET /settings', () => {
    test('returns empty array when no settings', async () => {
      const { status, data } = await jsonRequest(app, 'GET', '/settings');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });
  });

  describe('PUT /settings', () => {
    test('saves and retrieves settings', async () => {
      const { status } = await jsonRequest(app, 'PUT', '/settings', [
        { key: 'theme', value: 'dark' },
        { key: 'lang', value: 'zh-CN' },
      ]);
      expect(status).toBe(200);

      const { data } = await jsonRequest(app, 'GET', '/settings');
      expect(data).toHaveLength(2);
      expect(data.find((s: any) => s.key === 'theme')?.value).toBe('dark');
    });

    test('rejects non-array body', async () => {
      const { status, data } = await jsonRequest(app, 'PUT', '/settings', { key: 'x' });
      expect(status).toBe(400);
      expect(data.message).toContain('array');
    });
  });
});
