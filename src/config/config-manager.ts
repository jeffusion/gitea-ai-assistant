/**
 * Three-layer configuration manager.
 * Priority: Zod defaults → process.env → JSON overrides
 *
 * Override file format:
 *   { version: 1, updatedAt: string, overrides: Record<string, string> }
 *
 * Bun-friendly IO: reads via readFile, writes atomically via temp+rename.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env before any process.env access (must precede singleton construction)
dotenvConfig();

// ---------------------------------------------------------------------------
// Override file types
// ---------------------------------------------------------------------------

interface OverridesFile {
  version: 1;
  updatedAt: string;
  overrides: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Zod schema (identical to src/config/index.ts)
// ---------------------------------------------------------------------------

const defaultAllowedReviewCommands = ['git', 'rg', 'cat', 'sed', 'wc'];

const envSchema = z.object({
  // Gitea
  GITEA_API_URL: z.string().url().default('http://localhost:5174/api/v1'),
  GITEA_ACCESS_TOKEN: z.string().default('test_token'),
  GITEA_ADMIN_TOKEN: z.string().optional(),

  // OpenAI
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().default('test_openai_key'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  CUSTOM_SUMMARY_PROMPT: z.string().optional(),
  CUSTOM_LINE_COMMENT_PROMPT: z.string().optional(),
  GLOBAL_PROMPT: z.string().optional(),

  // Feishu
  FEISHU_WEBHOOK_URL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().url().optional()
  ),
  FEISHU_WEBHOOK_SECRET: z.string().optional(),

  // App
  PORT: z.string().transform(Number).default('5174'),
  WEBHOOK_SECRET: z.string().default('test_webhook_secret'),

  // Admin
  ADMIN_PASSWORD: z.string().default('password'),
  JWT_SECRET: z.string().default('a-secure-secret-for-jwt'),

  // Review engine
  REVIEW_ENGINE: z.enum(['legacy', 'agent']).default('legacy'),
  REVIEW_WORKDIR: z.string().default('/tmp/gitea-assistant'),
  REVIEW_MODEL_PLANNER: z.string().default('gpt-4o-mini'),
  REVIEW_MODEL_SPECIALIST: z.string().default('gpt-4o-mini'),
  REVIEW_MODEL_JUDGE: z.string().default('gpt-4o-mini'),
  REVIEW_MAX_PARALLEL_RUNS: z.coerce.number().int().min(1).max(8).default(2),
  REVIEW_MAX_FILES_PER_RUN: z.coerce.number().int().min(1).max(1000).default(200),
  REVIEW_MAX_FILE_CONTENT_CHARS: z.coerce.number().int().min(1000).max(1_000_000).default(40_000),
  REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  REVIEW_ENABLE_HUMAN_GATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  REVIEW_ALLOWED_COMMANDS: z.string().default(defaultAllowedReviewCommands.join(',')),
  REVIEW_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(10000),

  // Memory & learning
  QDRANT_URL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().url().optional()
  ),
  ENABLE_MEMORY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  FEW_SHOT_EXAMPLES_COUNT: z.coerce.number().int().min(0).max(20).default(10),

  // Reflection & debate
  ENABLE_REFLECTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAX_REFLECTION_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
  ENABLE_DEBATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DEBATE_THRESHOLD: z.enum(['high', 'medium']).default('high'),
});

// ---------------------------------------------------------------------------
// Config shape (matches default export of src/config/index.ts)
// ---------------------------------------------------------------------------

export interface AppConfig {
  gitea: {
    apiUrl: string;
    accessToken: string;
  };
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    customSummaryPrompt: string | undefined;
    customLineCommentPrompt: string | undefined;
    globalPrompt: string | undefined;
  };
  feishu: {
    webhookUrl: string | undefined;
    webhookSecret: string | undefined;
  };
  app: {
    port: number;
    webhookSecret: string;
  };
  admin: {
    password: string;
    jwtSecret: string;
    giteaAdminToken: string | undefined;
  };
  review: {
    engine: string;
    workdir: string;
    modelPlanner: string;
    modelSpecialist: string;
    modelJudge: string;
    maxParallelRuns: number;
    maxFilesPerRun: number;
    maxFileContentChars: number;
    autoPublishMinConfidence: number;
    enableHumanGate: boolean;
    allowedCommands: string[];
    commandTimeoutMs: number;
    qdrantUrl: string | undefined;
    enableMemory: boolean;
    fewShotExamplesCount: number;
    enableReflection: boolean;
    maxReflectionRounds: number;
    enableDebate: boolean;
    debateThreshold: string;
  };
}

// ---------------------------------------------------------------------------
// Dev fallback (matches src/config/index.ts behavior when validation fails)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

class ConfigManager {
  private readonly overridesPath: string;
  private overrides: Record<string, string> = {};

  constructor() {
    this.overridesPath = resolve(process.env.CONFIG_OVERRIDES_PATH || './config-overrides.json');
    this.loadOverridesSync();
  }

  /** Synchronously load overrides at construction time (file is tiny). */
  private loadOverridesSync(): void {
    try {
      const text = readFileSync(this.overridesPath, 'utf-8');
      const data: OverridesFile = JSON.parse(text);
      if (data && typeof data.overrides === 'object' && data.overrides !== null) {
        this.overrides = { ...data.overrides };
      }
    } catch {
      // File missing or invalid JSON — start with empty overrides
    }
  }

  // ── Override file I/O ────────────────────────────────────────────────────

  /** Load overrides from disk. If file is missing or malformed, treat as empty. */
  async loadOverrides(): Promise<void> {
    try {
      const text = await readFile(this.overridesPath, 'utf-8');
      const data: OverridesFile = JSON.parse(text);
      if (data && typeof data.overrides === 'object' && data.overrides !== null) {
        this.overrides = { ...data.overrides };
      } else {
        this.overrides = {};
      }
    } catch {
      // File missing or invalid JSON — start with empty overrides
      this.overrides = {};
    }
  }

  /** Persist current overrides to disk. Tries atomic rename; falls back to direct write. */
  private async persistOverrides(): Promise<void> {
    const dir = dirname(this.overridesPath);
    await mkdir(dir, { recursive: true });

    const payload: OverridesFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      overrides: { ...this.overrides },
    };

    const json = JSON.stringify(payload, null, 2);

    // Atomic rename may fail on K8s volumes (EBUSY/EXDEV); fall back to direct write.
    const tmpPath = `${this.overridesPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, json, 'utf-8');
      await rename(tmpPath, this.overridesPath);
    } catch {
      await writeFile(this.overridesPath, json, 'utf-8');
      // Clean up orphaned tmp file (best effort)
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  // ── Core API ─────────────────────────────────────────────────────────────

  /**
   * Returns the fully resolved config object with the same shape as the
   * default export of `src/config/index.ts`.
   *
   * Layering: Zod defaults → process.env → overrides JSON
   */
  getCurrent(): AppConfig {
    // Build a merged env-like record: process.env overlaid with overrides
    const merged: Record<string, string | undefined> = {};
    for (const key of Object.keys(envSchema.shape)) {
      const envVal = process.env[key];
      if (envVal !== undefined && envVal !== '') {
        merged[key] = envVal;
      }
      // Override wins if present and non-empty
      const ov = this.overrides[key];
      if (ov !== undefined && ov !== '') {
        merged[key] = ov;
      }
    }

    const parseResult = envSchema.safeParse(merged);

    if (!parseResult.success) {
      throw new Error('Configuration validation error');
    }

    const env = parseResult.data;

    return {
      gitea: {
        apiUrl: env.GITEA_API_URL,
        accessToken: env.GITEA_ACCESS_TOKEN,
      },
      openai: {
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        customSummaryPrompt: env.CUSTOM_SUMMARY_PROMPT,
        customLineCommentPrompt: env.CUSTOM_LINE_COMMENT_PROMPT,
        globalPrompt: env.GLOBAL_PROMPT,
      },
      feishu: {
        webhookUrl: env.FEISHU_WEBHOOK_URL,
        webhookSecret: env.FEISHU_WEBHOOK_SECRET,
      },
      app: {
        port: env.PORT,
        webhookSecret: env.WEBHOOK_SECRET,
      },
      admin: {
        password: env.ADMIN_PASSWORD,
        jwtSecret: env.JWT_SECRET,
        giteaAdminToken: env.GITEA_ADMIN_TOKEN,
      },
      review: {
        engine: env.REVIEW_ENGINE,
        workdir: env.REVIEW_WORKDIR,
        modelPlanner: env.REVIEW_MODEL_PLANNER,
        modelSpecialist: env.REVIEW_MODEL_SPECIALIST,
        modelJudge: env.REVIEW_MODEL_JUDGE,
        maxParallelRuns: env.REVIEW_MAX_PARALLEL_RUNS,
        maxFilesPerRun: env.REVIEW_MAX_FILES_PER_RUN,
        maxFileContentChars: env.REVIEW_MAX_FILE_CONTENT_CHARS,
        autoPublishMinConfidence: env.REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE,
        enableHumanGate: env.REVIEW_ENABLE_HUMAN_GATE,
        allowedCommands: env.REVIEW_ALLOWED_COMMANDS.split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        commandTimeoutMs: env.REVIEW_COMMAND_TIMEOUT_MS,
        qdrantUrl: env.QDRANT_URL,
        enableMemory: env.ENABLE_MEMORY,
        fewShotExamplesCount: env.FEW_SHOT_EXAMPLES_COUNT,
        enableReflection: env.ENABLE_REFLECTION,
        maxReflectionRounds: env.MAX_REFLECTION_ROUNDS,
        enableDebate: env.ENABLE_DEBATE,
        debateThreshold: env.DEBATE_THRESHOLD,
      },
    };
  }

  /** Return raw overrides record. */
  getOverrides(): Record<string, string> {
    return { ...this.overrides };
  }

  /**
   * Merge updates into overrides and persist.
   * If a value is empty string `''`, that key is deleted (reset to lower layer).
   */
  async setOverrides(updates: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(updates)) {
      if (value === '') {
        delete this.overrides[key];
      } else {
        this.overrides[key] = value;
      }
    }
    await this.persistOverrides();
  }

  /** Remove specified keys from overrides and persist. */
  async resetKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      delete this.overrides[key];
    }
    await this.persistOverrides();
  }

  /**
   * Determine where the effective value for a given env key comes from.
   */
  getSource(envKey: string): 'default' | 'env' | 'override' {
    const ov = this.overrides[envKey];
    if (ov !== undefined && ov !== '') {
      return 'override';
    }
    const envVal = process.env[envKey];
    if (envVal !== undefined && envVal !== '') {
      return 'env';
    }
    return 'default';
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const configManager = new ConfigManager();
