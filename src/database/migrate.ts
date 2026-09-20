import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { QueryExecutor } from '../types/index.js';
import type { Logger } from '../logging/logger.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * File-based, additive-only migration runner.
 *
 * Safety properties (per project policy "never destroy production data"):
 *  - migrations are immutable once applied — the checksum of every applied
 *    file is recorded and re-verified on each run; editing an applied
 *    migration FAILS the run instead of silently re-applying;
 *  - each migration runs in its own transaction;
 *  - applied migrations are skipped, never re-run.
 */
export async function runMigrations(
  executor: QueryExecutor,
  migrationsDir: string,
  logger: Logger
): Promise<MigrationResult> {
  try {
    await executor.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT PRIMARY KEY,
         checksum   TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
  } catch (err) {
    // On Postgres, CREATE TABLE IF NOT EXISTS never errors when the table
    // exists. Some engines (pg-mem in the test suite) still reject a
    // re-run of IF NOT EXISTS DDL, so probe for the table's presence and
    // only surface the original error when the table is genuinely missing.
    try {
      await executor.query('SELECT version FROM schema_migrations LIMIT 1');
    } catch {
      throw err;
    }
  }

  const appliedRes = await executor.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations'
  );
  const applied = new Map(appliedRes.rows.map((r) => [r.version, r.checksum]));

  let files: string[] = [];
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    logger.warn({ dir: migrationsDir, err: { message: (err as Error).message } }, 'migrations dir not readable — skipping');
    return { applied: [], skipped: [] };
  }

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = sha256(sql);

    const existing = applied.get(version);
    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new Error(
          `Migration ${version} was modified after being applied (checksum mismatch). ` +
            'Never edit applied migrations — add a new one instead.'
        );
      }
      result.skipped.push(version);
      continue;
    }

    logger.info({ version }, 'applying migration');
    await executor.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
    });
    result.applied.push(version);
  }

  return result;
}

/** Verify checksums of all applied migrations without applying anything. */
export async function verifyMigrations(
  executor: QueryExecutor,
  migrationsDir: string
): Promise<{ ok: boolean; problems: string[] }> {
  const appliedRes = await executor.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations'
  );
  const problems: string[] = [];
  for (const row of appliedRes.rows) {
    let file: string;
    try {
      file = path.join(migrationsDir, `${row.version}.sql`);
    } catch {
      continue;
    }
    try {
      const sql = await readFile(file, 'utf8');
      if (sha256(sql) !== row.checksum) {
        problems.push(`${row.version}: applied file was modified`);
      }
    } catch {
      problems.push(`${row.version}: applied but file missing`);
    }
  }
  return { ok: problems.length === 0, problems };
}
