import { describe, expect, it } from 'vitest';
import { JobScheduler } from '../src/jobs/scheduler.js';
import { FakeExecutor, silentLogger } from './helpers/fakes.js';

/**
 * Scheduler unit tests use a small in-memory "jobs table" driven through
 * the FakeExecutor: SELECT-DUE returns due rows, UPDATE calls mutate state.
 */
class InMemJobs {
  rows: Array<Record<string, unknown>> = [];
  private nextId = 1;

  insert(partial: Record<string, unknown>) {
    this.rows.push({
      id: String(this.nextId++),
      name: '',
      type: '',
      guild_id: null,
      payload: {},
      runs_at: new Date(),
      status: 'pending',
      recurring_ms: null,
      last_error: null,
      ...partial
    });
  }

  makeExecutor() {
    const db = new FakeExecutor();
    // Match the SELECT ... FROM jobs ... WHERE status = 'pending' claim query.
    db.on(/SELECT id, name, type.*FROM jobs[\s\S]*?pending/, () => this.dueRows());
    db.on(/UPDATE jobs SET status = 'processing'/, () => []);
    db.on(/UPDATE jobs SET status = \$2/, () => []);
    return db;
  }

  dueRows() {
    const now = Date.now();
    return this.rows
      .filter((r) => r.status === 'pending' && new Date(r.runs_at as string | Date).getTime() <= now)
      .slice(0, 20)
      .map((r) => ({ ...r, payload: JSON.stringify(r.payload) }));
  }

  /** Apply the scheduler's finish UPDATE (status by $2). */
  applyFinish(params: unknown[]) {
    const [id, status] = params as [string, string];
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.status = status;
      row.last_error = params[2] ?? null;
      if (params[3]) row.runs_at = params[3];
    }
  }
}

describe('JobScheduler', () => {
  it('executes due jobs exactly once and marks them done', async () => {
    const store = new InMemJobs();
    store.insert({ name: 'n1', type: 'job_a', runs_at: new Date(Date.now() - 1000) });
    const db = store.makeExecutor();
    const processed: string[] = [];
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => new Date());

    // Patch the fake to also record finish updates.
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (/UPDATE jobs SET status = \$2/.test(text)) store.applyFinish(params);
      return origQuery(text, params);
    };

    scheduler.register('job_a', async () => {
      processed.push('a');
    });

    const count = await scheduler.tick();
    expect(count).toBe(1);
    expect(processed).toEqual(['a']);
    expect(store.rows[0]!.status).toBe('done');

    // Second tick: nothing due.
    expect(await scheduler.tick()).toBe(0);
  });

  it('marks failed jobs with the error message and does not retry', async () => {
    const store = new InMemJobs();
    store.insert({ name: 'n2', type: 'job_b', runs_at: new Date(Date.now() - 1000) });
    const db = store.makeExecutor();
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (/UPDATE jobs SET status = \$2/.test(text)) store.applyFinish(params);
      return origQuery(text, params);
    };
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => new Date());
    scheduler.register('job_b', async () => {
      throw new Error('boom');
    });
    await scheduler.tick();
    expect(store.rows[0]!.status).toBe('failed');
    expect(store.rows[0]!.last_error).toBe('boom');
  });

  it('reschedules recurring jobs for a future run', async () => {
    const store = new InMemJobs();
    const past = new Date(Date.now() - 60_000);
    store.insert({ name: 'n3', type: 'job_c', runs_at: past, recurring_ms: 3_600_000 });
    const db = store.makeExecutor();
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (/UPDATE jobs SET status = \$2/.test(text)) store.applyFinish(params);
      return origQuery(text, params);
    };
    const now = new Date(Date.now());
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => now);
    scheduler.register('job_c', async () => undefined);
    await scheduler.tick();
    expect(store.rows[0]!.status).toBe('pending');
    const next = new Date(store.rows[0]!.runs_at as string | Date);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('marks unknown job types done without throwing', async () => {
    const store = new InMemJobs();
    store.insert({ name: 'n4', type: 'unknown_type', runs_at: new Date(Date.now() - 1000) });
    const db = store.makeExecutor();
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (/UPDATE jobs SET status = \$2/.test(text)) store.applyFinish(params);
      return origQuery(text, params);
    };
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => new Date());
    await expect(scheduler.tick()).resolves.toBe(1);
    expect(store.rows[0]!.status).toBe('done');
  });

  it('schedule() is idempotent by (name, type) — uses ON CONFLICT upsert', async () => {
    const store = new InMemJobs();
    const db = store.makeExecutor();
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => new Date());
    await scheduler.schedule({ name: 'dup', type: 't', runsAt: new Date(Date.now() + 1000) });
    await scheduler.schedule({ name: 'dup', type: 't', runsAt: new Date(Date.now() + 2000) });
    const upserts = db.calls.filter((c) => c.text.includes('ON CONFLICT (name, type)'));
    expect(upserts.length).toBe(2);
    expect(upserts[1]?.params[4]).toBeInstanceOf(Date);
  });

  it('guard: concurrent ticks do not double-process', async () => {
    const store = new InMemJobs();
    store.insert({ name: 'n5', type: 'job_d', runs_at: new Date(Date.now() - 1000) });
    const db = store.makeExecutor();
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (/UPDATE jobs SET status = \$2/.test(text)) store.applyFinish(params);
      return origQuery(text, params);
    };
    let runs = 0;
    const scheduler = new JobScheduler(db, silentLogger(), 60_000, () => new Date());
    scheduler.register('job_d', async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
    });
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(a + b).toBe(1);
    expect(runs).toBe(1);
  });
});
