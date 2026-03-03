// @ts-expect-error bun:test is provided by Bun at runtime
declare module 'bun:test' {
  export const describe: any;
  export const test: any;
  export const it: any;
  export const expect: any;
  export const beforeEach: any;
  export const afterEach: any;
  export const beforeAll: any;
  export const afterAll: any;
}

// @ts-expect-error bun:test is provided by Bun at runtime
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config-manager';

// ── All env keys in the Zod schema ──────────────────────────────────────────
const SCHEMA_KEYS = [
  'GITEA_API_URL', 'GITEA_ACCESS_TOKEN', 'GITEA_ADMIN_TOKEN',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'CUSTOM_SUMMARY_PROMPT', 'CUSTOM_LINE_COMMENT_PROMPT',
  'FEISHU_WEBHOOK_URL', 'FEISHU_WEBHOOK_SECRET',
  'PORT', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD', 'JWT_SECRET',
  'REVIEW_ENGINE', 'REVIEW_WORKDIR', 'REVIEW_MODEL_PLANNER',
  'REVIEW_MODEL_SPECIALIST', 'REVIEW_MODEL_JUDGE',
  'REVIEW_MAX_PARALLEL_RUNS', 'REVIEW_MAX_FILES_PER_RUN',
  'REVIEW_MAX_FILE_CONTENT_CHARS', 'REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE',
  'REVIEW_ENABLE_HUMAN_GATE', 'REVIEW_ALLOWED_COMMANDS', 'REVIEW_COMMAND_TIMEOUT_MS',
  'QDRANT_URL', 'ENABLE_MEMORY', 'FEW_SHOT_EXAMPLES_COUNT',
  'ENABLE_REFLECTION', 'MAX_REFLECTION_ROUNDS', 'ENABLE_DEBATE', 'DEBATE_THRESHOLD',
] as const;

const CONTROL_KEYS = ['CONFIG_OVERRIDES_PATH', 'NODE_ENV'] as const;
const ALL_KEYS: readonly string[] = [...SCHEMA_KEYS, ...CONTROL_KEYS];

/**
 * Dynamically import a fresh config-manager module.
 * Appending a unique query string to the specifier forces Bun to bypass the
 * module cache, giving us a brand-new ConfigManager singleton each time.
 */
async function importFresh() {
  const mod = await import(`../config-manager.ts?t=${Date.now()}-${randomUUID()}`);
  return mod.configManager;
}

describe('ConfigManager', () => {
  let tmpPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpPath = join(tmpdir(), `cfg-test-${randomUUID()}.json`);

    // Snapshot every env key we might touch
    for (const key of ALL_KEYS) {
      savedEnv[key] = process.env[key];
    }

    // Neutralise all schema keys ('' is treated as "absent" by getCurrent).
    // This also prevents dotenv from injecting values from a local .env file.
    for (const key of SCHEMA_KEYS) {
      process.env[key] = '';
    }

    // Per-test temp overrides file
    process.env.CONFIG_OVERRIDES_PATH = tmpPath;

    // FEISHU_WEBHOOK_URL has no Zod default → must be a valid URL for schema to pass.
    process.env.FEISHU_WEBHOOK_URL = 'https://hooks.example.com/test';
  });

  afterEach(async () => {
    for (const key of ALL_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key]!;
      }
    }
    try { await unlink(tmpPath); } catch { /* ok if missing */ }
  });

  // ─── 1. Layering: defaults < env < override ─────────────────────────

  describe('layering: defaults < env < override', () => {
    test('Zod default used when env and override are absent', async () => {
      const cm = await importFresh();
      expect(cm.getCurrent().openai.model).toBe('gpt-4o-mini');
    });

    test('env value overrides Zod default', async () => {
      process.env.OPENAI_MODEL = 'env-model';
      const cm = await importFresh();
      expect(cm.getCurrent().openai.model).toBe('env-model');
    });

    test('override wins over env', async () => {
      process.env.OPENAI_MODEL = 'env-model';
      const cm = await importFresh();
      await cm.setOverrides({ OPENAI_MODEL: 'override-model' });
      expect(cm.getCurrent().openai.model).toBe('override-model');
    });
  });

  // ─── 2. Empty string resets override ─────────────────────────────────

  describe('empty string resets override', () => {
    test('setting override to "" removes it, value falls back to Zod default', async () => {
      const cm = await importFresh();
      await cm.setOverrides({ OPENAI_MODEL: 'temp-override' });
      expect(cm.getCurrent().openai.model).toBe('temp-override');

      await cm.setOverrides({ OPENAI_MODEL: '' });

      // OPENAI_MODEL is '' in env (neutralised) → falls to Zod default
      expect(cm.getCurrent().openai.model).toBe('gpt-4o-mini');
      expect(cm.getOverrides()).not.toHaveProperty('OPENAI_MODEL');
    });
  });

  // ─── 3. Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    test('setOverrides writes JSON file; new instance loads it', async () => {
      const cm1 = await importFresh();
      await cm1.setOverrides({ OPENAI_MODEL: 'persisted-model' });

      // File structure check
      const raw = await readFile(tmpPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.version).toBe(1);
      expect(typeof data.updatedAt).toBe('string');
      expect(data.overrides.OPENAI_MODEL).toBe('persisted-model');

      // Fresh instance picks it up
      const cm2 = await importFresh();
      expect(cm2.getCurrent().openai.model).toBe('persisted-model');
    });
  });

  // ─── 4. getSource() ─────────────────────────────────────────────────

  describe('getSource()', () => {
    test('returns "default" when neither env nor override is set', async () => {
      // OPENAI_MODEL = '' (neutralised) → getSource sees '' → 'default'
      const cm = await importFresh();
      expect(cm.getSource('OPENAI_MODEL')).toBe('default');
    });

    test('returns "env" when process.env has a non-empty value', async () => {
      process.env.OPENAI_MODEL = 'from-env';
      const cm = await importFresh();
      expect(cm.getSource('OPENAI_MODEL')).toBe('env');
    });

    test('returns "override" when override is set', async () => {
      process.env.OPENAI_MODEL = 'from-env';
      const cm = await importFresh();
      await cm.setOverrides({ OPENAI_MODEL: 'from-override' });
      expect(cm.getSource('OPENAI_MODEL')).toBe('override');
    });
  });

  // ─── 5. Dev fallback ─────────────────────────────────────────────────

  describe('dev fallback', () => {
    test('FEISHU_WEBHOOK_URL missing + NODE_ENV=development → feishu.webhookUrl ""', async () => {
      process.env.FEISHU_WEBHOOK_URL = ''; // invalid → safeParse fails
      process.env.NODE_ENV = 'development';
      const cm = await importFresh();
      const cfg: AppConfig = cm.getCurrent();
      expect(cfg.feishu.webhookUrl).toBe('');
    });

    test('FEISHU_WEBHOOK_URL missing + NODE_ENV unset → feishu.webhookUrl ""', async () => {
      process.env.FEISHU_WEBHOOK_URL = '';
      process.env.NODE_ENV = ''; // falsy → same branch as undefined
      const cm = await importFresh();
      const cfg: AppConfig = cm.getCurrent();
      expect(cfg.feishu.webhookUrl).toBe('');
    });
  });
});
