// 简单的日志实用工具

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/**
 * 格式化时间
 */
function formatTime(): string {
  return new Date().toISOString();
}

/**
 * 格式化日志消息
 */
function formatMessage(level: LogLevel, message: string, meta?: any): string {
  const timestamp = formatTime();

  let formattedMessage = `[${timestamp}] [${level}] ${message}`;

  if (meta) {
    try {
      formattedMessage += ` - ${JSON.stringify(meta)}`;
    } catch (error) {
      formattedMessage += ` - ${meta}`;
    }
  }

  return formattedMessage;
}

/**
 * 日志实用工具
 */
export const logger = {
  debug(message: string, meta?: any) {
    console.debug(formatMessage(LogLevel.DEBUG, message, meta));
  },

  info(message: string, meta?: any) {
    console.info(formatMessage(LogLevel.INFO, message, meta));
  },

  warn(message: string, meta?: any) {
    console.warn(formatMessage(LogLevel.WARN, message, meta));
  },

  error(message: string, meta?: any) {
    console.error(formatMessage(LogLevel.ERROR, message, meta));
  },
};
