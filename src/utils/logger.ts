import pino from 'pino';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

type LogMeta = Record<string, unknown>;
type ErrorWithCode = Error & { code?: unknown };

function resolveLogLevel(rawLevel: string | undefined): LogLevel {
  if (!rawLevel) {
    return LogLevel.INFO;
  }

  const normalized = rawLevel.toLowerCase();
  if (normalized === LogLevel.DEBUG) return LogLevel.DEBUG;
  if (normalized === LogLevel.INFO) return LogLevel.INFO;
  if (normalized === LogLevel.WARN) return LogLevel.WARN;
  if (normalized === LogLevel.ERROR) return LogLevel.ERROR;
  return LogLevel.INFO;
}

function toLogMeta(meta: unknown): LogMeta | undefined {
  if (meta === undefined) {
    return undefined;
  }

  if (meta instanceof Error) {
    const maybeCode = (meta as ErrorWithCode).code;
    const code =
      typeof maybeCode === 'string' || typeof maybeCode === 'number' ? maybeCode : undefined;

    return {
      error: {
        name: meta.name,
        message: meta.message,
        stack: meta.stack,
        ...(code !== undefined ? { code } : {}),
      },
    };
  }

  if (typeof meta === 'object' && meta !== null) {
    return meta as LogMeta;
  }

  return { meta };
}

const baseLogger = pino({
  level: resolveLogLevel(process.env.LOG_LEVEL),
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
});

function writeLog(level: LogLevel, message: string, meta?: unknown): void {
  const logMeta = toLogMeta(meta);
  if (logMeta) {
    baseLogger[level](logMeta, message);
    return;
  }

  baseLogger[level](message);
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    writeLog(LogLevel.DEBUG, message, meta);
  },

  info(message: string, meta?: unknown): void {
    writeLog(LogLevel.INFO, message, meta);
  },

  warn(message: string, meta?: unknown): void {
    writeLog(LogLevel.WARN, message, meta);
  },

  error(message: string, meta?: unknown): void {
    writeLog(LogLevel.ERROR, message, meta);
  },
};
