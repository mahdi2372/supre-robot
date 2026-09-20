import type { QueryExecutor, QueryResult, TransactionClient } from '../../src/types/index.js';
import { MemoryCache } from '../../src/cache/memory.js';

export { MemoryCache };

/**
 * Minimal in-memory QueryExecutor for unit tests.
 *
 * It is intentionally dumb: tests register query handlers that match by
 * SQL substring and return canned rows. This keeps unit tests fast and free
 * of a real database, while integration tests (tests/integration) exercise
 * the real SQL against Postgres.
 */
type RowProvider = unknown[] | (() => unknown[]);

export class FakeExecutor implements QueryExecutor {
  handlers: Array<{ match: RegExp; rows: RowProvider; rowCount?: number }> = [];
  public calls: Array<{ text: string; params: unknown[] }> = [];
  public transactionCalls = 0;

  on(match: RegExp, rows: RowProvider, rowCount?: number): this {
    this.handlers.push({ match, rows, rowCount });
    return this;
  }

  private resolveRows(h: { rows: RowProvider; rowCount?: number }): unknown[] {
    return typeof h.rows === 'function' ? h.rows() : h.rows;
  }

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    this.calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    for (const h of this.handlers) {
      if (h.match.test(text.replace(/\s+/g, ' ').trim())) {
        const rows = this.resolveRows(h);
        return { rows: rows as T[], rowCount: h.rowCount ?? rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const client: TransactionClient = {
      query: async <TQ = unknown>(text: string, params: unknown[] = []): Promise<QueryResult<TQ>> => {
        this.calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
        for (const h of this.handlers) {
          if (h.match.test(text.replace(/\s+/g, ' ').trim())) {
            const rows = this.resolveRows(h) as TQ[];
            return { rows, rowCount: h.rowCount ?? rows.length };
          }
        }
        return { rows: [] as TQ[], rowCount: 0 };
      }
    };
    return fn(client);
  }
}

/** pino-compatible no-op logger for tests. */
export function silentLogger() {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    child: () => logger
  };
  return logger as never;
}
