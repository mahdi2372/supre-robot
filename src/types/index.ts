/**
 * Shared low-level types used across the platform.
 */

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Minimal data-access contract. The real implementation wraps a `pg.Pool`;
 * tests inject in-memory fakes. Keeping this interface tiny lets module code
 * stay decoupled from the driver.
 */
export interface QueryExecutor {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * Run `fn` inside a transaction. Commits on resolve, rolls back on throw.
   */
  transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;
}

export interface TransactionClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface ScheduledJob {
  id: string;
  name: string;
  type: string;
  guildId: string | null;
  payload: Record<string, unknown>;
  runsAt: Date;
  status: 'pending' | 'processing' | 'done' | 'failed';
  recurringMs: number | null;
  lastError: string | null;
}

export type BotStatus = 'starting' | 'ready' | 'degraded' | 'api-only' | 'shutting_down' | 'stopped';

export interface SystemStatusSnapshot {
  bot: {
    status: BotStatus;
    version: string;
    uptimeMs: number;
    latencyMs: number | null;
    username: string | null;
    guildCount: number | null;
  };
  database: { connected: boolean; lastPingMs: number | null };
  modules: Record<string, { status: string; version: string }>;
  errors: {
    total: number;
    last30Min: number;
    ratePerMinute: number;
    recent: Array<{ code: string; module: string; at: string }>;
  };
  commands: { total: number; byName: Record<string, number> };
}
