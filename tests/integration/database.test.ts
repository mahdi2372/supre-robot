import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { IMemoryDb } from 'pg-mem';
import { createTestDb, migrationsDir } from '../helpers/pgmem.js';
import { executorFor, type Pool } from '../../src/database/pool.js';
import { runMigrations, verifyMigrations } from '../../src/database/migrate.js';
import { SettingsService } from '../../src/core/settings.js';
import { MemoryCache } from '../../src/cache/memory.js';
import { silentLogger } from '../helpers/fakes.js';
import type { QueryExecutor } from '../../src/types/index.js';

/**
 * Integration tests through the real pg driver against pg-mem's SQL engine
 * (real parser/planner, real migration SQL, real constraint semantics).
 *
 * pg-mem's in-process adapter does not implement per-connection SQL
 * transaction state, so transaction tests assert the statement sequence
 * our executor issues (captured via the db's 'query' event) rather than
 * data-level rollback effects.
 */
let pool: Pool;
let db: QueryExecutor;
let memDb: IMemoryDb;
const applied: string[] = [];

beforeAll(async () => {
  const test = createTestDb();
  pool = test.pool;
  memDb = test.db;
  db = executorFor(pool);
  const result = await runMigrations(db, migrationsDir(), silentLogger());
  applied.push(...result.applied);
});

describe('migrations', () => {
  it('applied the initial schema', () => {
    expect(applied).toContain('0001_initial');
  });

  it('is idempotent — a second run applies nothing', async () => {
    const result = await runMigrations(db, migrationsDir(), silentLogger());
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0001_initial');
  });

  it('verifies checksums of applied migrations', async () => {
    const check = await verifyMigrations(db, migrationsDir());
    expect(check.ok).toBe(true);
  });

  it('fails loudly if an applied migration file is modified', async () => {
    // Simulate tampering by registering a second migration, applying it,
    // then rewriting the on-disk SQL.
    const dir = migrationsDir();
    const file = `${dir}/9999_tamper_test.sql`;
    const fs = await import('node:fs');
    try {
      fs.writeFileSync(file, 'CREATE TABLE tamper_probe (id int);');
      const res = await runMigrations(db, dir, silentLogger());
      expect(res.applied).toContain('9999_tamper_test');
      fs.writeFileSync(file, 'CREATE TABLE tamper_probe (id int, extra int);');
      await expect(runMigrations(db, dir, silentLogger())).rejects.toThrow(/modified after being applied/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('settings service against real SQL', () => {
  const schema = z
    .object({
      channel: z.string().nullable().default(null),
      count: z.number().int().min(1).max(100).default(10)
    })
    .default({});
  const defaults = { channel: null as string | null, count: 10 };

  it('round-trips default → patch → merged settings with caching', async () => {
    const settings = new SettingsService(db, new MemoryCache(), silentLogger());
    settings.register('itest', { schema, defaults });

    await settings.ensureGuild('ig1', 'IT Server');
    const initial = await settings.get<typeof defaults>('ig1', 'itest');
    expect(initial).toEqual(defaults);

    const patched = await settings.set('ig1', 'itest', { count: 77 } as never, 'actor');
    expect(patched.count).toBe(77);

    const after = await settings.get<typeof defaults>('ig1', 'itest');
    expect(after.count).toBe(77);
    expect(after.channel).toBeNull();
  });

  it('stores and honors the enabled flag', async () => {
    const settings = new SettingsService(db, new MemoryCache(), silentLogger());
    expect(await settings.isEnabled('ig1', 'itest')).toBe(true);
    await settings.setEnabled('ig1', 'itest', false, 'actor');
    expect(await settings.isEnabled('ig1', 'itest')).toBe(false);
    await settings.setEnabled('ig1', 'itest', true, 'actor');
    expect(await settings.isEnabled('ig1', 'itest')).toBe(true);
  });

  it('rejects invalid patches at the SQL boundary too', async () => {
    const settings = new SettingsService(db, new MemoryCache(), silentLogger());
    settings.register('itest2', {
      schema: z.object({ n: z.number().int().min(1).default(1) }).default({}),
      defaults: { n: 1 }
    });
    await settings.ensureGuild('ig1', 'IT Server');
    await expect(settings.set('ig1', 'itest2', { n: -3 } as never, 'a')).rejects.toThrow();
    const row = await settings.get<{ n: number }>('ig1', 'itest2');
    expect(row.n).toBe(1);
  });
});

describe('core data paths', () => {
  it('ensures guild rows are idempotent', async () => {
    await db.query(`INSERT INTO servers (guild_id, name) VALUES ('ig2', 'A') ON CONFLICT (guild_id) DO UPDATE SET name = EXCLUDED.name`, []);
    await db.query(`INSERT INTO servers (guild_id, name) VALUES ('ig2', 'B') ON CONFLICT (guild_id) DO UPDATE SET name = EXCLUDED.name`, []);
    const res = await db.query<{ name: string }>('SELECT name FROM servers WHERE guild_id = $1', ['ig2']);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.name).toBe('B');
  });

  it('case counter increments atomically per guild', async () => {
    await db.query(`INSERT INTO servers (guild_id) VALUES ('ig3') ON CONFLICT DO NOTHING`, []);
    const a = await db.query<{ n: number }>('UPDATE servers SET case_counter = case_counter + 1 WHERE guild_id = $1 RETURNING case_counter AS n', ['ig3']);
    const b = await db.query<{ n: number }>('UPDATE servers SET case_counter = case_counter + 1 WHERE guild_id = $1 RETURNING case_counter AS n', ['ig3']);
    expect(a.rows[0]!.n).toBe(1);
    expect(b.rows[0]!.n).toBe(2);
  });

  it('persists and queries bot_logs by kind (JSONB round-trip)', async () => {
    await db.query(`INSERT INTO servers (guild_id) VALUES ('ig4') ON CONFLICT DO NOTHING`, []);
    await db.query(`INSERT INTO bot_logs (guild_id, kind, actor_id, data) VALUES ($1, 'security', 'u1', $2)`, [
      'ig4',
      JSON.stringify({ kind: 'test', token: 'should-stay-as-string' })
    ]);
    await db.query(`INSERT INTO bot_logs (guild_id, kind, data) VALUES ($1, 'mod_action', $2)`, [
      'ig4',
      JSON.stringify({ action: 'warn' })
    ]);
    const res = await db.query<{ kind: string; data: Record<string, unknown> }>(
      "SELECT kind, data FROM bot_logs WHERE guild_id = 'ig4' AND kind = 'security' ORDER BY created_at DESC"
    );
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0]!.data as Record<string, unknown>).token).toBe('should-stay-as-string');
  });

  it('enforces idempotency keys on transactions (double-spend protection)', async () => {
    await db.query(`INSERT INTO servers (guild_id) VALUES ('ig5') ON CONFLICT DO NOTHING`, []);
    await db.query(
      `INSERT INTO economy_accounts (guild_id, user_id, balance) VALUES ('ig5', 'u1', 100)`,
      []
    );
    await db.query(
      `INSERT INTO transactions (guild_id, user_id, kind, amount, balance_after, idempotency_key)
       VALUES ('ig5', 'u1', 'spend', -50, 50, 'idem-1')`,
      []
    );
    await expect(
      db.query(
        `INSERT INTO transactions (guild_id, user_id, kind, amount, balance_after, idempotency_key)
         VALUES ('ig5', 'u1', 'spend', -50, 50, 'idem-1')`,
        []
      )
    ).rejects.toThrow();
  });

  it('transactions commit on success and roll back on error', async () => {
    await db.query(`INSERT INTO servers (guild_id) VALUES ('ig6') ON CONFLICT DO NOTHING`, []);
    await db.query(`DELETE FROM custom_commands WHERE guild_id = 'ig6'`, []);

    // pg-mem's in-process adapter has no per-connection SQL transaction
    // state (ROLLBACK does not undo data), so we assert on the statement
    // sequence our executor issues through the real driver: BEGIN … COMMIT
    // on success, BEGIN … ROLLBACK + rethrow on error.
    const issued: string[] = [];
    const sub = memDb.on('query', (q: string) => issued.push(q.replace(/\s+/g, ' ').trim().replace(/;+$/, '')));
    try {
      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO custom_commands (guild_id, name, response) VALUES ('ig6', 'keep', 'hi')`, []);
      });
      expect(issued).toContain('BEGIN');
      expect(issued).toContain('COMMIT');
      expect(issued.indexOf('BEGIN')).toBeLessThan(issued.indexOf('COMMIT'));

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO custom_commands (guild_id, name, response) VALUES ('ig6', 'discard', 'bye')`, []);
          throw new Error('rollback please');
        })
      ).rejects.toThrow('rollback please');
      expect(issued).toContain('ROLLBACK');
    } finally {
      sub.unsubscribe();
    }

    const res = await db.query<{ name: string }>('SELECT name FROM custom_commands WHERE guild_id = $1', ['ig6']);
    expect(res.rows.map((r) => r.name)).toContain('keep'); // committed data is visible
  });

  it('the scheduler claim query shape works (plain FOR UPDATE in this test DB)', async () => {
    await db.query(`INSERT INTO servers (guild_id) VALUES ('ig7') ON CONFLICT DO NOTHING`, []);
    await db.query(
      `INSERT INTO jobs (name, type, guild_id, runs_at) VALUES ('itest-job', 'test_type', 'ig7', now() - interval '1 hour')`,
      []
    );
    const due = await db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'pending' AND runs_at <= now() ORDER BY runs_at LIMIT 1 FOR UPDATE`
    );
    expect(due.rows).toHaveLength(1);
    await db.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [due.rows[0]!.id]);
  });

  it('migration file is self-describing', () => {
    const sql = readFileSync(`${migrationsDir()}/0001_initial.sql`, 'utf8');
    for (const table of [
      'servers',
      'guild_settings',
      'users',
      'members',
      'managed_roles',
      'warnings',
      'moderation_cases',
      'tickets',
      'ticket_messages',
      'giveaways',
      'polls',
      'economy_accounts',
      'transactions',
      'automod_rules',
      'security_events',
      'bot_logs',
      'custom_commands',
      'automation_rules',
      'jobs',
      'dashboard_sessions'
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
  });
});
