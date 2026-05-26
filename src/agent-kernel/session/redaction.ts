const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'authorization',
  'auth_token',
  'access_token',
  'refresh_token',
  'token',
  'password',
  'passwd',
  'secret',
  'credential',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, '_').toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactSensitiveFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactSensitiveFields(childValue);
  }
  return redacted as T;
}
