import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * Custom log format for console output.
 */
const consoleFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const errorStack = stack ? `\n${stack}` : '';
  return `[${timestamp}] ${level}: ${message}${metaStr}${errorStack}`;
});

/**
 * Custom log format for file output (JSON).
 */
const fileFormat = printf(({ level, message, timestamp, ...meta }) => {
  return JSON.stringify({ timestamp, level, message, ...meta });
});

/**
 * Application-wide logger instance.
 * Outputs colored logs to console and JSON logs to files.
 */
export const logger = winston.createLogger({
  level: config.logging.level,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
  ),
  defaultMeta: { service: 'makeitlegend-bot' },
  transports: [
    // Console transport with colors
    new winston.transports.Console({
      format: combine(colorize(), consoleFormat),
    }),
    // Error log file
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Combined log file
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: fileFormat,
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

/**
 * Creates a child logger with a specific module label.
 */
export function createModuleLogger(module: string): winston.Logger {
  return logger.child({ module });
}
