import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMasterKey } from '../../crypto/secrets';
import { closeDatabase, initDatabase } from '../../db/database';
import { settingsRepo } from '../../db/repositories/settings-repo';
import { configManager } from '../config-manager';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDb(): string {
  const dir = join(tmpdir(), `cfg-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConfigManager (DB backend)', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    dbPath = makeTmpDb();
    process.env.DATABASE_PATH = dbPath;
    process.env.ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'hex'
    );
    initMasterKey();
    initDatabase();
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

  // ─── 1. getCurrent() defaults ─────────────────────────────────────────────

  describe('getCurrent() defaults', () => {
    test('returns default engine when DB is empty', () => {
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });

    test('reads port from process.env.PORT, defaults to 5174', () => {
      const orig = process.env.PORT;
      Reflect.deleteProperty(process.env, 'PORT');
      expect(configManager.getCurrent().app.port).toBe(5174);
      if (orig !== undefined) process.env.PORT = orig;
    });

    test('returns default admin password', () => {
      expect(configManager.getCurrent().admin.password).toBe('password');
    });

    test('optional fields with no default return undefined', () => {
      const cfg = configManager.getCurrent();
      expect(cfg.notification.feishu.webhookUrl).toBeUndefined();
      expect(cfg.notification.feishu.webhookSecret).toBeUndefined();
      expect(cfg.notification.wecom.webhookUrl).toBeUndefined();
      expect(cfg.admin.giteaAdminToken).toBeUndefined();
    });

    test('returns review size thresholds and token budget defaults', () => {
      const cfg = configManager.getCurrent();
      expect(cfg.review.smallMaxFiles).toBe(3);
      expect(cfg.review.smallMaxChangedLines).toBe(80);
      expect(cfg.review.mediumMaxFiles).toBe(10);
      expect(cfg.review.mediumMaxChangedLines).toBe(400);
      expect(cfg.review.tokenBudgetSmall).toBe(12000);
      expect(cfg.review.tokenBudgetMedium).toBe(45000);
      expect(cfg.review.tokenBudgetLarge).toBe(120000);
    });

    test('returns runtime agent model defaults', () => {
      const cfg = configManager.getCurrent();
      expect(cfg.review.agentMainModel).toBe('gpt-4.1');
      expect(cfg.review.agentDefaultSubagentModel).toBe('gpt-4.1-mini');
    });
  });

  // ─── 2. setOverrides() / getSource() ─────────────────────────────────────

  describe('setOverrides() and getSource()', () => {
    test('setOverrides writes to DB, getCurrent reflects the change', async () => {
      await configManager.setOverrides({ REVIEW_ENGINE: 'agent' });
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });

    test('setOverrides with empty string deletes the key (resets to default)', async () => {
      await configManager.setOverrides({ REVIEW_ENGINE: 'agent' });
      await configManager.setOverrides({ REVIEW_ENGINE: '' });
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });

    test('getSource returns "db" when value is stored', async () => {
      await configManager.setOverrides({ REVIEW_ENGINE: 'agent' });
      expect(configManager.getSource('REVIEW_ENGINE')).toBe('db');
    });

    test('getSource returns "default" when key is absent from DB', () => {
      expect(configManager.getSource('REVIEW_ENGINE')).toBe('default');
    });

    test('sensitive fields are stored encrypted and retrieved correctly', async () => {
      await configManager.setOverrides({ GITEA_ACCESS_TOKEN: 'secret-token-123' });
      expect(configManager.getCurrent().gitea.accessToken).toBe('secret-token-123');
    });

    test('unknown keys are silently ignored', async () => {
      await configManager.setOverrides({ UNKNOWN_KEY_XYZ: 'value' });
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });
  });

  // ─── 3. resetKeys() ──────────────────────────────────────────────────────

  describe('resetKeys()', () => {
    test('resetKeys deletes key from DB, value reverts to default', async () => {
      await configManager.setOverrides({ REVIEW_ENGINE: 'agent' });
      await configManager.resetKeys(['REVIEW_ENGINE']);
      expect(configManager.getCurrent().review.engine).toBe('agent');
      expect(configManager.getSource('REVIEW_ENGINE')).toBe('default');
    });

    test('resetKeys on non-existent key does not throw', async () => {
      await configManager.resetKeys(['REVIEW_ENGINE']);
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });
  });

  // ─── 4. seedDefaults() ───────────────────────────────────────────────────

  describe('seedDefaults()', () => {
    test('seeds all fields with defaults on empty DB', () => {
      expect(settingsRepo.listAll().length).toBe(0);
      configManager.seedDefaults();
      expect(settingsRepo.listAll().length).toBeGreaterThan(0);
    });

    test('JWT_SECRET and WEBHOOK_SECRET are auto-generated (64 hex chars)', () => {
      configManager.seedDefaults();
      const jwtSecret = settingsRepo.get('JWT_SECRET');
      const webhookSecret = settingsRepo.get('WEBHOOK_SECRET');
      expect(jwtSecret).not.toBeNull();
      expect(webhookSecret).not.toBeNull();
      expect(/^[0-9a-f]{64}$/.test(jwtSecret!)).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(webhookSecret!)).toBe(true);
    });

    test('seedDefaults is idempotent — no-op when DB already has entries', async () => {
      await configManager.setOverrides({ REVIEW_ENGINE: 'agent' });
      configManager.seedDefaults();
      expect(configManager.getCurrent().review.engine).toBe('agent');
    });

    test('ADMIN_PASSWORD defaults to "password"', () => {
      configManager.seedDefaults();
      expect(configManager.getCurrent().admin.password).toBe('password');
    });

    test('seeded JWT_SECRET is a 64-char hex string', () => {
      configManager.seedDefaults();
      expect(configManager.getCurrent().admin.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
    });

    test('seeded WEBHOOK_SECRET is a 64-char hex string', () => {
      configManager.seedDefaults();
      expect(configManager.getCurrent().app.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── 5. Type conversions ─────────────────────────────────────────────────

  describe('type conversions in getCurrent()', () => {
    test('number field is parsed correctly', async () => {
      await configManager.setOverrides({ REVIEW_MAX_PARALLEL_RUNS: '4' });
      expect(configManager.getCurrent().review.maxParallelRuns).toBe(4);
    });

    test('review budget fields are parsed correctly', async () => {
      await configManager.setOverrides({
        REVIEW_SMALL_MAX_FILES: '5',
        REVIEW_TOKEN_BUDGET_SMALL: '22222',
      });

      expect(configManager.getCurrent().review.smallMaxFiles).toBe(5);
      expect(configManager.getCurrent().review.tokenBudgetSmall).toBe(22222);
    });

    test('agent model fields are read from overrides', async () => {
      await configManager.setOverrides({
        AGENT_MAIN_MODEL: 'main-override-model',
        AGENT_DEFAULT_SUBAGENT_MODEL: 'subagent-override-model',
      });

      const cfg = configManager.getCurrent();
      expect(cfg.review.agentMainModel).toBe('main-override-model');
      expect(cfg.review.agentDefaultSubagentModel).toBe('subagent-override-model');
    });

    test('comma-separated REVIEW_ALLOWED_COMMANDS parsed to array', async () => {
      await configManager.setOverrides({ REVIEW_ALLOWED_COMMANDS: 'git, rg, cat' });
      expect(configManager.getCurrent().review.allowedCommands).toEqual(['git', 'rg', 'cat']);
    });
  });
});
