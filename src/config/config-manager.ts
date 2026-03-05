import { randomBytes } from 'node:crypto';
import { settingsRepo } from '../db/repositories/settings-repo';
import { CONFIG_FIELDS, type ConfigFieldMeta } from './config-schema';

// ---------------------------------------------------------------------------
// Config shape (matches default export of src/config/index.ts)
// ---------------------------------------------------------------------------

export interface AppConfig {
  gitea: {
    apiUrl: string;
    accessToken: string;
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
    customSummaryPrompt: string | undefined;
    customLineCommentPrompt: string | undefined;
    globalPrompt: string | undefined;
    maxParallelRuns: number;
    maxFilesPerRun: number;
    maxFileContentChars: number;
    autoPublishMinConfidence: number;
    enableHumanGate: boolean;
    allowedCommands: string[];
    commandTimeoutMs: number;
    llmMaxConcurrentCalls: number;
    llmRetryMaxAttempts: number;
    llmRetryBaseDelayMs: number;
    enableTriage: boolean;
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
// ConfigManager
// ---------------------------------------------------------------------------

class ConfigManager {
  private readonly fieldsMap = new Map<string, ConfigFieldMeta>(
    CONFIG_FIELDS.map((field) => [field.envKey, field])
  );

  private defaultToString(value: string | number | boolean): string {
    if (typeof value === 'string') return value;
    return String(value);
  }

  private getRawValue(key: string): string | undefined {
    try {
      const fromDb = settingsRepo.get(key);
      if (fromDb !== null) {
        return fromDb;
      }
    } catch {
      // DB not initialized yet (e.g. during tests that don't init DB)
      // Fall through to return the default value below
    }

    const field = this.fieldsMap.get(key);
    if (!field || field.defaultValue === undefined) {
      return undefined;
    }

    return this.defaultToString(field.defaultValue);
  }

  getAllRawValues(): Record<string, string | undefined> {
    const values: Record<string, string | undefined> = {};
    for (const field of CONFIG_FIELDS) {
      values[field.envKey] = this.getRawValue(field.envKey);
    }
    return values;
  }

  getCurrent(): AppConfig {
    const values = this.getAllRawValues();
    const portValue = process.env.PORT;
    const parsedPort = portValue !== undefined && portValue !== '' ? Number(portValue) : 5174;
    const port = Number.isFinite(parsedPort) ? parsedPort : 5174;

    const toNumber = (key: string, fallback: number): number => {
      const raw = values[key];
      if (raw === undefined) return fallback;
      const num = Number(raw);
      return Number.isFinite(num) ? num : fallback;
    };

    const toBoolean = (key: string, fallback: boolean): boolean => {
      const raw = values[key];
      if (raw === undefined) return fallback;
      return raw === 'true';
    };

    const toStringArray = (key: string, fallback: string[]): string[] => {
      const raw = values[key];
      if (raw === undefined) return fallback;
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    };

    return {
      gitea: {
        apiUrl: values.GITEA_API_URL ?? 'http://localhost:5174/api/v1',
        accessToken: values.GITEA_ACCESS_TOKEN ?? 'test_token',
      },
      feishu: {
        webhookUrl: values.FEISHU_WEBHOOK_URL,
        webhookSecret: values.FEISHU_WEBHOOK_SECRET,
      },
      app: {
        port,
        webhookSecret: values.WEBHOOK_SECRET ?? 'test_webhook_secret',
      },
      admin: {
        password: values.ADMIN_PASSWORD ?? 'password',
        jwtSecret: values.JWT_SECRET ?? 'a-secure-secret-for-jwt',
        giteaAdminToken: values.GITEA_ADMIN_TOKEN,
      },
      review: {
        engine: values.REVIEW_ENGINE ?? 'legacy',
        workdir: values.REVIEW_WORKDIR ?? '/tmp/gitea-assistant',
        customSummaryPrompt: values.CUSTOM_SUMMARY_PROMPT,
        customLineCommentPrompt: values.CUSTOM_LINE_COMMENT_PROMPT,
        globalPrompt: values.GLOBAL_PROMPT,
        maxParallelRuns: toNumber('REVIEW_MAX_PARALLEL_RUNS', 2),
        maxFilesPerRun: toNumber('REVIEW_MAX_FILES_PER_RUN', 200),
        maxFileContentChars: toNumber('REVIEW_MAX_FILE_CONTENT_CHARS', 40000),
        autoPublishMinConfidence: toNumber('REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE', 0.8),
        enableHumanGate: toBoolean('REVIEW_ENABLE_HUMAN_GATE', true),
        allowedCommands: toStringArray('REVIEW_ALLOWED_COMMANDS', [
          'git',
          'rg',
          'cat',
          'sed',
          'wc',
        ]),
        commandTimeoutMs: toNumber('REVIEW_COMMAND_TIMEOUT_MS', 10000),
        llmMaxConcurrentCalls: toNumber('LLM_MAX_CONCURRENT_CALLS', 4),
        llmRetryMaxAttempts: toNumber('LLM_RETRY_MAX_ATTEMPTS', 3),
        llmRetryBaseDelayMs: toNumber('LLM_RETRY_BASE_DELAY_MS', 1000),
        enableTriage: toBoolean('ENABLE_TRIAGE', true),
        qdrantUrl: values.QDRANT_URL,
        enableMemory: toBoolean('ENABLE_MEMORY', false),
        fewShotExamplesCount: toNumber('FEW_SHOT_EXAMPLES_COUNT', 10),
        enableReflection: toBoolean('ENABLE_REFLECTION', false),
        maxReflectionRounds: toNumber('MAX_REFLECTION_ROUNDS', 2),
        enableDebate: toBoolean('ENABLE_DEBATE', false),
        debateThreshold: values.DEBATE_THRESHOLD ?? 'high',
      },
    };
  }

  async setOverrides(updates: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(updates)) {
      const field = this.fieldsMap.get(key);
      if (!field) {
        continue;
      }

      if (value === '') {
        settingsRepo.delete(key);
      } else {
        settingsRepo.set(key, value, field.sensitive);
      }
    }
  }

  async resetKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      settingsRepo.delete(key);
    }
  }

  getSource(envKey: string): 'default' | 'db' {
    try {
      return settingsRepo.get(envKey) !== null ? 'db' : 'default';
    } catch {
      return 'default';
    }
  }

  seedDefaults(): void {
    if (settingsRepo.listAll().length > 0) {
      return;
    }

    for (const field of CONFIG_FIELDS) {
      let value: string | undefined;

      if (field.envKey === 'JWT_SECRET' || field.envKey === 'WEBHOOK_SECRET') {
        value = randomBytes(32).toString('hex');
      } else if (field.envKey === 'ADMIN_PASSWORD') {
        value = 'password';
      } else if (field.defaultValue !== undefined) {
        value = this.defaultToString(field.defaultValue);
      }

      if (value !== undefined) {
        settingsRepo.set(field.envKey, value, field.sensitive);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const configManager = new ConfigManager();
