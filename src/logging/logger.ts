import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

const REDACT_PATHS = [
  'token',
  '*.token',
  'secret',
  '*.secret',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'authorization',
  'cookie',
  '*.authorization',
  '*.cookie'
];

/**
 * Structured JSON logger with secret redaction. Pretty output is only used
 * in development (where pino-pretty is a dev dependency).
 */
export function createLogger(name: string, level: string = 'info', pretty = false): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' }
          }
        }
      : {})
  });
}

/**
 * Format an Error for structured logging: message + stack, but the stack is
 * never sent to Discord users (see src/utils/errors.ts).
 */
export function errorObject(err: unknown): { err: { message: string; stack?: string; name: string } } {
  if (err instanceof Error) {
    return { err: { message: err.message, name: err.name, stack: err.stack } };
  }
  return { err: { message: String(err), name: 'UnknownError' } };
}
