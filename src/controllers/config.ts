import { Hono } from 'hono';
import { type AppConfig, configManager } from '../config/config-manager';
import { CONFIG_FIELDS, CONFIG_GROUPS, type ConfigFieldMeta } from '../config/config-schema';
import { logger } from '../utils/logger';

// ── Constants ────────────────────────────────────────────────────────────────

const MASKED_VALUE = '••••••••';

/** Number fields that must be integers (decimal not allowed). */
const INTEGER_FIELDS = new Set([
  'PORT',
  'REVIEW_MAX_PARALLEL_RUNS',
  'REVIEW_MAX_FILES_PER_RUN',
  'REVIEW_MAX_FILE_CONTENT_CHARS',
  'REVIEW_COMMAND_TIMEOUT_MS',
  'FEW_SHOT_EXAMPLES_COUNT',
  'MAX_REFLECTION_ROUNDS',
]);

/** Fast lookup from envKey → field metadata. */
const FIELDS_MAP = new Map<string, ConfigFieldMeta>(CONFIG_FIELDS.map((f) => [f.envKey, f]));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map an envKey to its effective value from the resolved AppConfig.
 * Explicit switch — no dynamic property access.
 */
function getEffectiveValue(
  envKey: string,
  current: AppConfig
): string | number | boolean | undefined {
  switch (envKey) {
    // Gitea
    case 'GITEA_API_URL':
      return current.gitea.apiUrl;
    case 'GITEA_ACCESS_TOKEN':
      return current.gitea.accessToken;
    case 'GITEA_ADMIN_TOKEN':
      return current.admin.giteaAdminToken;
    // Review prompts (moved from OpenAI group)
    case 'CUSTOM_SUMMARY_PROMPT':
      return current.review.customSummaryPrompt;
    case 'CUSTOM_LINE_COMMENT_PROMPT':
      return current.review.customLineCommentPrompt;
    case 'GLOBAL_PROMPT':
      return current.review.globalPrompt;
    // Feishu
    case 'FEISHU_WEBHOOK_URL':
      return current.feishu.webhookUrl;
    case 'FEISHU_WEBHOOK_SECRET':
      return current.feishu.webhookSecret;
    // App
    case 'PORT':
      return current.app.port;
    case 'WEBHOOK_SECRET':
      return current.app.webhookSecret;
    // Admin
    case 'ADMIN_PASSWORD':
      return current.admin.password;
    case 'JWT_SECRET':
      return current.admin.jwtSecret;
    // Review
    case 'REVIEW_ENGINE':
      return current.review.engine;
    case 'REVIEW_WORKDIR':
      return current.review.workdir;
    case 'REVIEW_MAX_PARALLEL_RUNS':
      return current.review.maxParallelRuns;
    case 'REVIEW_MAX_FILES_PER_RUN':
      return current.review.maxFilesPerRun;
    case 'REVIEW_MAX_FILE_CONTENT_CHARS':
      return current.review.maxFileContentChars;
    case 'REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE':
      return current.review.autoPublishMinConfidence;
    case 'REVIEW_ENABLE_HUMAN_GATE':
      return current.review.enableHumanGate;
    case 'REVIEW_ALLOWED_COMMANDS':
      return current.review.allowedCommands.join(',');
    case 'REVIEW_COMMAND_TIMEOUT_MS':
      return current.review.commandTimeoutMs;
    // Memory
    case 'QDRANT_URL':
      return current.review.qdrantUrl;
    case 'ENABLE_MEMORY':
      return current.review.enableMemory;
    case 'FEW_SHOT_EXAMPLES_COUNT':
      return current.review.fewShotExamplesCount;
    case 'ENABLE_REFLECTION':
      return current.review.enableReflection;
    case 'MAX_REFLECTION_ROUNDS':
      return current.review.maxReflectionRounds;
    case 'ENABLE_DEBATE':
      return current.review.enableDebate;
    case 'DEBATE_THRESHOLD':
      return current.review.debateThreshold;
    default:
      return undefined;
  }
}

/**
 * Validate a single field value against its metadata.
 * Returns an error message string, or `null` if valid.
 */
function validateField(field: ConfigFieldMeta, key: string, value: string): string | null {
  switch (field.type) {
    case 'url': {
      try {
        new URL(value);
      } catch {
        return `${field.label}（${key}）必须是有效的 URL`;
      }
      return null;
    }
    case 'enum': {
      if (field.enumValues && !field.enumValues.includes(value)) {
        return `${field.label}（${key}）必须是以下值之一: ${field.enumValues.join(', ')}`;
      }
      return null;
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        return `${field.label}（${key}）必须是布尔值`;
      }
      return null;
    }
    case 'number': {
      const num = Number(value);
      if (Number.isNaN(num)) {
        return `${field.label}（${key}）必须是有效的数字`;
      }
      if (INTEGER_FIELDS.has(key) && !Number.isInteger(num)) {
        return `${field.label}（${key}）必须是整数`;
      }
      if (field.min !== undefined && num < field.min) {
        return `${field.label}（${key}）不能小于 ${field.min}`;
      }
      if (field.max !== undefined && num > field.max) {
        return `${field.label}（${key}）不能大于 ${field.max}`;
      }
      return null;
    }
    default:
      // string, text — no special validation
      return null;
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const configRouter = new Hono();

/**
 * GET / — Return all configuration groups, fields with metadata,
 * effective values, and source. Sensitive fields are masked.
 */
configRouter.get('/', (c) => {
  const current = configManager.getCurrent();

  const groups = CONFIG_GROUPS.map((group) => {
    const groupFields = CONFIG_FIELDS.filter((f) => f.group === group.key);

    const fields = groupFields.map((field) => {
      const rawValue = getEffectiveValue(field.envKey, current);
      const hasValue = rawValue !== undefined && rawValue !== '';
      const source = configManager.getSource(field.envKey);
      const value = field.sensitive && hasValue ? MASKED_VALUE : rawValue;

      return {
        envKey: field.envKey,
        label: field.label,
        description: field.description,
        type: field.type,
        sensitive: field.sensitive,
        ...(field.readonly && { readonly: true }),
        ...(field.readonlyWarning !== undefined && { readonlyWarning: field.readonlyWarning }),
        ...(field.enumValues !== undefined && { enumValues: field.enumValues }),
        ...(field.min !== undefined && { min: field.min }),
        ...(field.max !== undefined && { max: field.max }),
        ...(field.defaultValue !== undefined && { defaultValue: field.defaultValue }),
        value,
        hasValue,
        source,
      };
    });

    return {
      key: group.key,
      label: group.label,
      description: group.description,
      icon: group.icon,
      fields,
    };
  });

  return c.json({ groups });
});

/**
 * PUT / — Validate and persist override updates.
 * Masked sentinel ('••••••••') for sensitive fields is silently skipped.
 * Empty string '' causes the key to be reset (deleted from overrides).
 */
configRouter.put('/', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ message: '保存配置失败', error: '请求体必须是 JSON 对象' }, 400);
    }

    const updates: Record<string, string> = {};
    const errors: string[] = [];

    for (const [key, rawValue] of Object.entries(body)) {
      const field = FIELDS_MAP.get(key);

      if (!field) {
        errors.push(`未知配置项: ${key}`);
        continue;
      }
      // Silently skip readonly fields — frontend sends entire form state
      if (field.readonly) {
        continue;
      }

      const value = String(rawValue ?? '');

      // Skip masked sentinel for sensitive fields — do not overwrite with mask
      if (field.sensitive && value === MASKED_VALUE) {
        continue;
      }

      // Empty string → reset (ConfigManager deletes the key)
      if (value === '') {
        updates[key] = '';
        continue;
      }

      const fieldError = validateField(field, key, value);
      if (fieldError) {
        errors.push(fieldError);
        continue;
      }

      updates[key] = value;
    }

    if (errors.length > 0) {
      return c.json({ message: '保存配置失败', error: errors.join('; ') }, 400);
    }

    await configManager.setOverrides(updates);
    return c.json({ success: true, message: '配置已保存' });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('保存配置失败:', error);
    return c.json({ message: '保存配置失败', error: errMsg }, 500);
  }
});

/**
 * POST /reset — Remove specified keys from overrides (revert to env / default).
 */
configRouter.post('/reset', async (c) => {
  try {
    const { keys } = await c.req.json<{ keys: unknown }>();

    if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === 'string')) {
      return c.json({ message: '保存配置失败', error: 'keys 必须是字符串数组' }, 400);
    }

    const unknownKeys = keys.filter((k) => !FIELDS_MAP.has(k));
    if (unknownKeys.length > 0) {
      return c.json(
        { message: '保存配置失败', error: `未知配置项: ${unknownKeys.join(', ')}` },
        400
      );
    }

    await configManager.resetKeys(keys);
    return c.json({ success: true, message: '配置已重置' });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('重置配置失败:', error);
    return c.json({ message: '保存配置失败', error: errMsg }, 500);
  }
});
