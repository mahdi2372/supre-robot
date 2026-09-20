import pg from 'pg';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor, QueryResult, TransactionClient } from '../types/index.js';

export type Pool = pg.Pool;

/**
 * PostgreSQL connection pool with sane production defaults:
 * bounded pool, statement timeout, connection timeout.
 */
export function createDatabasePool(config: AppConfig, logger: Logger): Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 10_000
  });
  pool.on('error', (err) => {
    logger.error({ err: { message: err.message } }, 'pg idle client error');
  });
  return pool;
}

export async function pingDatabase(pool: Pool): Promise<{ ok: boolean; ms: number | null }> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: null };
  }
}

/**
 * Adapt a pg.Pool to the QueryExecutor contract used across the app.
 * `transaction` checks out a client and commits/rolls back for you.
 */
export function executorFor(pool: Pool): QueryExecutor {
  return {
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const res = await pool.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
    async transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const bound: TransactionClient = {
        async query<T2 = unknown>(text: string, params: unknown[] = []): Promise<QueryResult<T2>> {
          const res = await client.query(text, params as unknown[]);
          return { rows: res.rows as T2[], rowCount: res.rowCount };
        }
      };
      try {
        await bound.query('BEGIN');
        const result = await fn(bound);
        await bound.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await bound.query('ROLLBACK');
        } catch {
          /* connection may be dead; pool will clean up */
        }
        throw err;
      } finally {
        client.release();
      }
    }
  };
}
