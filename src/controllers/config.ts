import { Hono } from 'hono';
import { configManager } from '../config/config-manager';
import { CONFIG_FIELDS, CONFIG_GROUPS, type ConfigFieldMeta } from '../config/config-schema';
import { logger } from '../utils/logger';

// ── Constants ────────────────────────────────────────────────────────────────

const MASKED_VALUE = '••••••••';

/** Number fields that must be integers (decimal not allowed). */
const INTEGER_FIELDS = new Set([
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
  const rawValues = configManager.getAllRawValues();

  const groups = CONFIG_GROUPS.map((group) => {
    const groupFields = CONFIG_FIELDS.filter((f) => f.group === group.key);

    const fields = groupFields.map((field) => {
      const rawValue = rawValues[field.envKey];
      const hasValue = rawValue !== undefined && rawValue !== '';
      const source = configManager.getSource(field.envKey);
      const value = field.sensitive && hasValue ? MASKED_VALUE : rawValue;

      return {
        envKey: field.envKey,
        label: field.label,
        description: field.description,
        type: field.type,
        sensitive: field.sensitive,
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
 * PUT / — Validate and persist configuration updates.
 * Masked sentinel ('••••••••') for sensitive fields is silently skipped.
 * Empty string '' causes the key to be reset (deleted from DB).
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
 * POST /reset — Remove specified keys from DB (revert to default).
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
