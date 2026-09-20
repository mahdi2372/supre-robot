import { newDb, type IMemoryDb } from 'pg-mem';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * pg-mem runs a real `pg` client against an in-memory Postgres — so these
 * integration tests exercise the real driver and real SQL (including our
 * migrations). The in-process `createPg()` adapter routes every statement
 * through pg-mem's real parser/planner, including BEGIN/COMMIT/ROLLBACK.
 *
 * Limitations of pg-mem we work around in tests (production SQL stays
 * Postgres-correct):
 *  - `FOR UPDATE SKIP LOCKED` is unsupported; the scheduler's claim query
 *    is injectable for that reason.
 *  - The adapter has no per-connection SQL-transaction state, so a
 *    ROLLBACK does not undo data; tests that need transaction semantics
 *    assert on the statement sequence our executor issues (captured with
 *    `db.on('query')`) instead of data-level rollback.
 *  - Re-running `CREATE TABLE IF NOT EXISTS` with column constraints is
 *    rejected; runMigrations probes for the table when the DDL errors.
 */
export interface TestDb {
  pool: Pool;
  /** The underlying in-memory database (for event subscriptions). */
  db: IMemoryDb;
}

export function createTestDb(): TestDb {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool({ connectionString: 'postgres://test@test/testdb' });
  return { pool: pool as unknown as Pool, db: mem };
}

export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
}
