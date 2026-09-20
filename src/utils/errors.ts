/**
 * Typed, centralized error handling.
 *
 * Rule of the house:
 *  - throw `SupreError` with a stable `code` for every expected failure;
 *  - the interaction router maps `code` -> user-facing i18n message;
 *  - full stacks go to structured logs, never to users.
 */

export type ErrorCode =
  | 'PERMISSION_DENIED'
  | 'BOT_HIERARCHY'
  | 'MISSING_CHANNEL'
  | 'MISSING_ROLE'
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'EXPIRED_INTERACTION'
  | 'MODULE_DISABLED'
  | 'DB_ERROR'
  | 'DISCORD_API'
  | 'NOT_IN_GUILD'
  | 'INTERNAL';

export class SupreError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SupreError';
  }
}

export function isSupreError(err: unknown): err is SupreError {
  return err instanceof SupreError;
}

/** HTTP status for each error code (used by the API layer). */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  PERMISSION_DENIED: 403,
  BOT_HIERARCHY: 403,
  MISSING_CHANNEL: 404,
  MISSING_ROLE: 404,
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  EXPIRED_INTERACTION: 410,
  MODULE_DISABLED: 409,
  DB_ERROR: 503,
  DISCORD_API: 502,
  NOT_IN_GUILD: 403,
  INTERNAL: 500
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Map a Discord.js / discord-api errors to our codes. We intentionally only
 * handle the well-known cases; anything unexpected becomes INTERNAL and is
 * logged with its stack.
 */
export function normalizeDiscordError(err: unknown, fallbackMessage = 'Discord API request failed'): SupreError {
  if (isSupreError(err)) return err;

  const anyErr = err as { code?: number | string; raw?: { code?: number; message?: string }; message?: string };
  const code = anyErr?.raw?.code ?? anyErr?.code;

  if (code === 50035 || code === 10007) {
    return new SupreError('NOT_IN_GUILD', 'The target is not a member of this server.');
  }
  if (code === 50013 || code === 403) {
    return new SupreError('PERMISSION_DENIED', 'The bot is missing a required permission.');
  }
  if (code === 4011) {
    return new SupreError('RATE_LIMITED', 'The bot is currently rate limited by Discord; retry shortly.');
  }
  if (code === 10015) {
    return new SupreError('BOT_HIERARCHY', 'The target role is above the bot or of equal position.');
  }
  return new SupreError('DISCORD_API', fallbackMessage, { message: anyErr?.message });
}
