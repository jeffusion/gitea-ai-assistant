import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { jwt, sign } from 'hono/jwt';
import config from '../../config';
import { initMasterKey } from '../../crypto/secrets';
import { closeDatabase, initDatabase } from '../../db/database';
import { agentsRouter } from '../agents';

function createProtectedTestApp(): Hono {
  const app = new Hono();
  app.use('/admin/api/*', (c, next) => {
    const middleware = jwt({ secret: config.admin.jwtSecret, alg: 'HS256' });
    return middleware(c, next);
  });
  app.route('/admin/api/agents', agentsRouter);
  return app;
}

async function createAdminToken(): Promise<string> {
  return sign(
    {
      sub: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    config.admin.jwtSecret
  );
}

async function jsonRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(`http://localhost/admin/api/agents${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { _raw: text } };
  }
}

describe('agents controller', () => {
  let dbPath: string;
  let app: Hono;
  let tempProjectRoot: string;
  let savedCwd: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    const tmpDbDir = join(tmpdir(), `agents-ctrl-db-${randomUUID()}`);
    mkdirSync(tmpDbDir, { recursive: true });
    dbPath = join(tmpDbDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    process.env.ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'hex'
    );

    tempProjectRoot = join(tmpdir(), `agents-project-${randomUUID()}`);
    mkdirSync(join(tempProjectRoot, '.gitea-assistant', 'agents'), { recursive: true });
    writeFileSync(
      join(tempProjectRoot, '.gitea-assistant', 'agents', 'alpha.md'),
      [
        '---',
        'agentType: alpha-reviewer',
        'name: Alpha Reviewer',
        'whenToUse: Use alpha reviewer for repository checks.',
        'tools: [read_file, search_code]',
        'model: gpt-4.1',
        'maxTurns: 3',
        '---',
        'You are alpha reviewer.',
      ].join('\n')
    );
    writeFileSync(
      join(tempProjectRoot, '.gitea-assistant', 'agents', 'broken.md'),
      ['---', 'agentType: broken', 'name: Broken Agent', '---', '   '].join('\n')
    );

    savedCwd = process.cwd();
    process.chdir(tempProjectRoot);

    initMasterKey();
    initDatabase();
    app = createProtectedTestApp();
  });

  afterEach(() => {
    process.chdir(savedCwd);
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
    } catch {}
    try {
      if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    } catch {}
    try {
      if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
    } catch {}
    try {
      if (existsSync(tempProjectRoot)) rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {}
  });

  test('GET /definitions returns active/all definitions and load errors', async () => {
    const token = await createAdminToken();
    const { status, data } = await jsonRequest(app, 'GET', '/definitions', undefined, token);

    expect(status).toBe(200);
    expect(Array.isArray(data.activeDefinitions)).toBe(true);
    expect(Array.isArray(data.allDefinitions)).toBe(true);
    expect(Array.isArray(data.loadErrors)).toBe(true);

    const alpha = data.activeDefinitions.find((item: any) => item.agentType === 'alpha-reviewer');
    expect(alpha).toBeDefined();
    expect(alpha.source).toBe('project');
    expect(alpha.tools).toEqual(['read_file', 'search_code']);
    expect(alpha.model).toBe('gpt-4.1');
    expect(alpha.maxTurns).toBe(3);

    const broken = data.loadErrors.find((item: any) => item.filePath.endsWith('broken.md'));
    expect(broken).toBeDefined();
    expect(broken.code).toBe('empty_body');
  });

  test('GET /model-config returns runtime model defaults', async () => {
    const token = await createAdminToken();
    const { status, data } = await jsonRequest(app, 'GET', '/model-config', undefined, token);

    expect(status).toBe(200);
    expect(data).toHaveProperty('agentMainModel');
    expect(data).toHaveProperty('agentDefaultSubagentModel');
    expect(data).toHaveProperty('source');
  });

  test('PUT /model-config updates runtime model defaults', async () => {
    const token = await createAdminToken();
    const updateRes = await jsonRequest(
      app,
      'PUT',
      '/model-config',
      {
        agentMainModel: 'gpt-4.1-updated',
        agentDefaultSubagentModel: 'gpt-4.1-mini-updated',
      },
      token
    );

    expect(updateRes.status).toBe(200);
    expect(updateRes.data.agentMainModel).toBe('gpt-4.1-updated');
    expect(updateRes.data.agentDefaultSubagentModel).toBe('gpt-4.1-mini-updated');
    expect(updateRes.data.source.agentMainModel).toBe('db');
    expect(updateRes.data.source.agentDefaultSubagentModel).toBe('db');

    const readBack = await jsonRequest(app, 'GET', '/model-config', undefined, token);
    expect(readBack.status).toBe(200);
    expect(readBack.data.agentMainModel).toBe('gpt-4.1-updated');
    expect(readBack.data.agentDefaultSubagentModel).toBe('gpt-4.1-mini-updated');
  });

  test('returns 401 when missing authorization token', async () => {
    const defsRes = await jsonRequest(app, 'GET', '/definitions');
    expect(defsRes.status).toBe(401);

    const getModelRes = await jsonRequest(app, 'GET', '/model-config');
    expect(getModelRes.status).toBe(401);

    const putModelRes = await jsonRequest(app, 'PUT', '/model-config', {
      agentMainModel: 'nope',
    });
    expect(putModelRes.status).toBe(401);
  });
});
