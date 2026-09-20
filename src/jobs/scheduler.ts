import type { Logger } from '../logging/logger.js';
import type { QueryExecutor, ScheduledJob } from '../types/index.js';

export type JobTypeHandler = (job: ScheduledJob) => Promise<void>;

export const DEFAULT_SELECT_DUE = `
  SELECT id, name, type, guild_id, payload, runs_at, status, recurring_ms, last_error
  FROM jobs
  WHERE status = 'pending' AND runs_at <= $1
  ORDER BY runs_at ASC
  LIMIT 20
  FOR UPDATE SKIP LOCKED
`;

/**
 * Durable job scheduler.
 *
 * Jobs live in the `jobs` table, so they survive restarts: a temporary
 * punishment scheduled before a crash is still applied after it. The
 * scheduler polls for due jobs with `FOR UPDATE SKIP LOCKED`, which makes
 * concurrent instances safe (they will not double-execute a job).
 */
export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private handlers = new Map<string, JobTypeHandler>();
  private running = false;

  constructor(
    private readonly db: QueryExecutor,
    private readonly logger: Logger,
    private readonly intervalMs = 15_000,
    private readonly now: () => Date = () => new Date(),
    /** Overridable in tests (some test databases lack SKIP LOCKED). */
    private readonly selectDue: string = DEFAULT_SELECT_DUE
  ) {}

  register(type: string, handler: JobTypeHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Schedule a job. `name` is the stable unique key — re-scheduling with the
   * same name replaces the previous pending job (idempotent).
   */
  async schedule(opts: {
    name: string;
    type: string;
    guildId?: string | null;
    payload?: Record<string, unknown>;
    runsAt: Date;
    recurringMs?: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (name, type, guild_id, payload, runs_at, recurring_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name, type) DO UPDATE SET
         runs_at = EXCLUDED.runs_at,
         payload = EXCLUDED.payload,
         guild_id = EXCLUDED.guild_id,
         status = 'pending',
         recurring_ms = EXCLUDED.recurring_ms,
         last_error = NULL
       WHERE jobs.status <> 'processing'`,
      [opts.name, opts.type, opts.guildId ?? null, JSON.stringify(opts.payload ?? {}), opts.runsAt, opts.recurringMs ?? null]
    );
  }

  async cancel(name: string, type: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'done' WHERE name = $1 AND type = $2 AND status IN ('pending', 'processing')`,
      [name, type]
    );
  }

  start(): void {
    if (this.timer) return;
    this.logger.info({ intervalMs: this.intervalMs }, 'job scheduler started');
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error({ err: { message: (err as Error).message } }, 'scheduler tick failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    // Run immediately so jobs due at boot fire without waiting a full interval.
    this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Execute all due jobs. Returns the number of jobs processed. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.now();
      const claimed: ScheduledJob[] = await this.db.transaction(async (tx) => {
        const res = await tx.query<{
          id: string;
          name: string;
          type: string;
          guild_id: string | null;
          payload: string | Record<string, unknown>;
          runs_at: Date;
          status: string;
          recurring_ms: number | null;
          last_error: string | null;
        }>(this.selectDue, [now]);
        for (const row of res.rows) {
          await tx.query(`UPDATE jobs SET status = 'processing', last_run_at = now() WHERE id = $1`, [row.id]);
        }
        return res.rows.map((r) => this.toJob(r));
      });

      let processed = 0;
      for (const job of claimed) {
        await this.execute(job);
        processed += 1;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async execute(job: ScheduledJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.logger.warn({ jobType: job.type, jobName: job.name }, 'no handler registered for job type — marking done');
      await this.finish(job, { status: 'done' });
      return;
    }

    try {
      await handler(job);
      if (job.recurringMs && job.recurringMs > 0) {
        await this.finish(job, {
          status: 'pending',
          nextRunsAt: new Date(Math.max(job.runsAt.getTime() + job.recurringMs, this.now().getTime() + 1000))
        });
      } else {
        await this.finish(job, { status: 'done' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: { message, name: err instanceof Error ? err.name : 'unknown' }, jobName: job.name, jobType: job.type }, 'job failed');
      await this.finish(job, { status: 'failed', lastError: message });
    }
  }

  private async finish(job: ScheduledJob, opts: { status: 'done' | 'failed' | 'pending'; nextRunsAt?: Date; lastError?: string }): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = $2, last_error = $3, runs_at = COALESCE($4, runs_at), last_run_at = now() WHERE id = $1`,
      [job.id, opts.status, opts.lastError ?? null, opts.nextRunsAt ?? null]
    );
  }

  private toJob(row: {
    id: string;
    name: string;
    type: string;
    guild_id: string | null;
    payload: string | Record<string, unknown>;
    runs_at: Date;
    status: string;
    recurring_ms: number | null;
    last_error: string | null;
  }): ScheduledJob {
    return {
      id: String(row.id),
      name: row.name,
      type: row.type,
      guildId: row.guild_id,
      payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload ?? {},
      runsAt: row.runs_at instanceof Date ? row.runs_at : new Date(row.runs_at),
      status: row.status as ScheduledJob['status'],
      recurringMs: row.recurring_ms ? Number(row.recurring_ms) : null,
      lastError: row.last_error
    };
  }
}
