import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor } from '../types/index.js';
import { isSupreError, statusForCode } from '../utils/errors.js';
import { errorObject } from '../logging/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    sessionUser?: import('./auth.js').SessionUser | null;
  }
}

/** Assign a request id; used in logs and error responses. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function createApiLoggerMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Date.now() - start,
          ip: req.ip
        },
        'api request'
      );
    });
    next();
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
}

/**
 * Central API error handler. User-facing responses never include stacks;
 * SupreError codes map to stable status + message. Everything else is 500
 * with a generic message, and the full error is logged server-side.
 */
export function createApiErrorHandler(logger: Logger, db: QueryExecutor) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) return;

    // Malformed JSON body from the client.
    const bodyErr = err as { type?: string; status?: number };
    if (bodyErr?.type === 'entity.parse.failed' || bodyErr?.type === 'entity.too.large') {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'request body is malformed or too large', requestId: req.requestId }
      });
      return;
    }

    if (isSupreError(err)) {
      res.status(statusForCode(err.code)).json({
        error: { code: err.code, message: userFacingMessage(err.code), requestId: req.requestId }
      });
      return;
    }

    // Zod validation errors from settings writes.
    const zod = err as { issues?: unknown[]; name?: string };
    if (zod.name === 'ZodError' && Array.isArray(zod.issues)) {
      res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'validation failed',
          issues: zod.issues
            .slice(0, 10)
            .map((i) => (i as { path?: PropertyKey[]; message?: string }).message ?? 'invalid'),
          requestId: req.requestId
        }
      });
      return;
    }

    logger.error({ ...errorObject(err), requestId: req.requestId, path: req.originalUrl }, 'api unhandled error');
    void db
      .query(
        `INSERT INTO bot_logs (guild_id, kind, data) VALUES ('0', 'error', $1)`,
        [JSON.stringify({ path: req.originalUrl, message: err instanceof Error ? err.message : String(err) })]
      )
      .catch(() => undefined);
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'internal error', requestId: req.requestId }
    });
  };
}

function userFacingMessage(code: string): string {
  const map: Record<string, string> = {
    PERMISSION_DENIED: 'You do not have permission to perform this action.',
    BOT_HIERARCHY: 'The bot does not have sufficient authority for this action.',
    MISSING_CHANNEL: 'A valid channel could not be found.',
    MISSING_ROLE: 'A valid role could not be found.',
    INVALID_INPUT: 'Invalid input.',
    RATE_LIMITED: 'Rate limit exceeded — slow down.',
    EXPIRED_INTERACTION: 'This request has expired.',
    MODULE_DISABLED: 'This module is disabled for the server.',
    DB_ERROR: 'Database temporarily unavailable.',
    DISCORD_API: 'Discord API error.',
    NOT_IN_GUILD: 'Not a member of the server.',
    INTERNAL: 'Internal error.'
  };
  return map[code] ?? 'Unexpected error.';
}
