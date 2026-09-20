import { describe, expect, it } from 'vitest';
import { sanitizeForLog, safeSideEffect } from '../src/security/sanitize.js';
import { SupreError, isSupreError, normalizeDiscordError, statusForCode } from '../src/utils/errors.js';
import { formatAccountAge, formatDuration } from '../src/utils/format.js';

describe('sanitizeForLog', () => {
  it('redacts sensitive keys recursively', () => {
    const out = sanitizeForLog({
      token: 'secret-token',
      nested: { api_key: 'k', user: 'u', password: 'p' },
      list: [{ client_secret: 's' }, { safe: 1 }]
    }) as Record<string, unknown>;
    expect(out.token).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.api_key).toBe('[REDACTED]');
    expect(nested.password).toBe('[REDACTED]');
    expect(nested.user).toBe('u');
    const list = out.list as Array<Record<string, unknown>>;
    expect(list[0]!.client_secret).toBe('[REDACTED]');
    expect(list[1]!.safe).toBe(1);
  });

  it('redacts authorization headers', () => {
    const out = sanitizeForLog({ headers: { Authorization: 'Bearer xyz' } }) as Record<string, unknown>;
    const headers = out.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe('[REDACTED]');
  });

  it('truncates huge strings and deep structures', () => {
    const out = sanitizeForLog({ s: 'a'.repeat(5000) }) as Record<string, unknown>;
    expect((out.s as string).length).toBeLessThanOrEqual(2001);
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      cur.n = {};
      cur = cur.n as Record<string, unknown>;
    }
    expect(sanitizeForLog(deep)).toBeDefined(); // no stack overflow
  });

  it('handles dates, bigints and circular-safe primitives', () => {
    const out = sanitizeForLog({ d: new Date('2024-01-01T00:00:00Z'), b: 5n }) as Record<string, unknown>;
    expect(out.d).toBe('2024-01-01T00:00:00.000Z');
    expect(out.b).toBe('5');
  });
});

describe('safeSideEffect', () => {
  it('returns the value on success', async () => {
    await expect(safeSideEffect(async () => 42, () => undefined)).resolves.toBe(42);
  });
  it('swallows and reports errors', async () => {
    const seen: unknown[] = [];
    await expect(safeSideEffect(async () => {
      throw new Error('x');
    }, (e) => seen.push(e))).resolves.toBeUndefined();
    expect(seen.length).toBe(1);
  });
});

describe('error codes', () => {
  it('maps codes to statuses', () => {
    expect(statusForCode('PERMISSION_DENIED')).toBe(403);
    expect(statusForCode('RATE_LIMITED')).toBe(429);
    expect(statusForCode('DB_ERROR')).toBe(503);
    expect(statusForCode('INTERNAL')).toBe(500);
  });

  it('SupreError keeps its code', () => {
    const e = new SupreError('BOT_HIERARCHY', 'no');
    expect(isSupreError(e)).toBe(true);
    expect(e.code).toBe('BOT_HIERARCHY');
  });

  it('normalizes known Discord API errors', () => {
    const notInGuild = new Error('x');
    (notInGuild as { code?: number }).code = 50035;
    expect(normalizeDiscordError(notInGuild).code).toBe('NOT_IN_GUILD');

    const perms = new Error('x');
    (perms as { code?: number }).code = 50013;
    expect(normalizeDiscordError(perms).code).toBe('PERMISSION_DENIED');

    const generic = new Error('x');
    (generic as { code?: number }).code = 500;
    expect(normalizeDiscordError(generic).code).toBe('DISCORD_API');
  });
});

describe('formatting', () => {
  it('formats durations readably (en)', () => {
    expect(formatDuration(90 * 60_000)).toBe('1 hour, 30 minutes');
    expect(formatDuration(2 * 24 * 3600_000 + 3 * 3600_000)).toBe('2 days, 3 hours');
    expect(formatDuration(0)).toBe('0 minutes');
  });
  it('formats durations in bangla', () => {
    expect(formatDuration(30 * 60_000, 'bn')).toBe('30 মিনিট');
  });
  it('formats account ages', () => {
    const young = new Date(Date.now() - 2 * 3600_000);
    expect(formatAccountAge(young)).toBe('2 hours');
    const old = new Date(Date.now() - 5 * 24 * 3600_000);
    expect(formatAccountAge(old)).toBe('5 days');
  });
});
