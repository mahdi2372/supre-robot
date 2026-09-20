import { describe, expect, it } from 'vitest';
import { SettingsService } from '../src/core/settings.js';
import { z } from 'zod';
import { FakeExecutor, MemoryCache, silentLogger } from './helpers/fakes.js';

const schema = z
  .object({
    channel: z.string().nullable().default(null),
    count: z.number().int().min(1).max(100).default(10),
    mode: z.enum(['a', 'b']).default('a')
  })
  .default({});
const defaults = { channel: null as string | null, count: 10, mode: 'a' as 'a' | 'b' };

function makeService(rows: unknown[] = []) {
  const db = new FakeExecutor();
  db.on(/SELECT settings FROM guild_settings/, rows);
  return { service: new SettingsService(db, new MemoryCache(), silentLogger()), db };
}

describe('SettingsService', () => {
  it('returns validated defaults when no override exists', async () => {
    const { service } = makeService([]);
    service.register('demo', { schema, defaults });
    const s = await service.get<typeof defaults>('g1', 'demo');
    expect(s).toEqual(defaults);
  });

  it('merges stored overrides over defaults', async () => {
    const { service } = makeService([{ settings: { count: 42, mode: 'b' } }]);
    service.register('demo', { schema, defaults });
    const s = await service.get<typeof defaults>('g1', 'demo');
    expect(s.count).toBe(42);
    expect(s.mode).toBe('b');
    expect(s.channel).toBeNull();
  });

  it('rejects stored rows that fail validation (corrupt data never leaks)', async () => {
    const { service } = makeService([{ settings: { count: -5 } }]);
    service.register('demo', { schema, defaults });
    await expect(service.get('g1', 'demo')).rejects.toThrow();
  });

  it('caches reads and invalidates on set', async () => {
    // Model a real DB: the INSERT persists, so the next SELECT observes it.
    let stored: { settings: Record<string, unknown> } | null = null;
    const db = new FakeExecutor();
    db.on(/INSERT INTO guild_settings/, () => {
      const last = db.calls[db.calls.length - 1];
      stored = { settings: JSON.parse(String(last?.params[2] ?? '{}')) };
      return [];
    });
    db.on(/SELECT settings FROM guild_settings/, () => (stored ? [stored] : []));
    const service = new SettingsService(db, new MemoryCache(), silentLogger());
    service.register('demo', { schema, defaults });

    await service.get('g1', 'demo');
    await service.get('g1', 'demo');
    const readsBefore = db.calls.filter((c) => c.text.includes('SELECT settings')).length;
    expect(readsBefore).toBe(1); // second read served from cache

    const setRes = await service.set('g1', 'demo', { count: 99 } as never, 'actor');
    expect(setRes.count).toBe(99);
    const after = await service.get<typeof defaults>('g1', 'demo');
    expect(after.count).toBe(99);
  });

  it('rejects patches that produce invalid settings', async () => {
    const { service, db } = makeService([]);
    service.register('demo', { schema, defaults });
    await expect(service.set('g1', 'demo', { count: 10_000 } as never, 'a')).rejects.toThrow();
    expect(db.calls.some((c) => c.text.includes('INSERT INTO guild_settings'))).toBe(false);
  });

  it('throws for unknown modules', async () => {
    const { service } = makeService([]);
    await expect(service.get('g1', 'nope')).rejects.toThrow(/unknown module/);
    await expect(service.set('g1', 'nope', {} as never, 'a')).rejects.toThrow(/unknown module/);
  });

  it('module enabled state defaults to true and honors stored false', async () => {
    const db = new FakeExecutor();
    db.on(/SELECT enabled FROM guild_settings/, []);
    const service = new SettingsService(db, new MemoryCache(), silentLogger());
    expect(await service.isEnabled('g1', 'moderation')).toBe(true);

    db.handlers.length = 0;
    db.on(/SELECT enabled FROM guild_settings/, [{ enabled: false }]);
    expect(await service.isEnabled('g1', 'moderation')).toBe(false);
  });

  it('isEnabled degrades to true when the DB is down', async () => {
    const db = new FakeExecutor();
    db.on(/SELECT enabled FROM guild_settings/, []);
    const throwing = {
      query: async () => {
        throw new Error('db down');
      },
      transaction: async () => {
        throw new Error('db down');
      }
    };
    const service = new SettingsService(throwing, new MemoryCache(), silentLogger());
    expect(await service.isEnabled('g1', 'moderation')).toBe(true);
  });
});
