#!/usr/bin/env tsx
/**
 * Database CLI.
 *
 *   npm run db:migrate   — apply pending migrations
 *   npm run db:verify    — verify applied migrations against files
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../logging/logger.js';
import { createDatabasePool, executorFor } from './pool.js';
import { runMigrations, verifyMigrations } from './migrate.js';

const command = process.argv[2] ?? 'migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('db-cli', config.LOG_LEVEL);
  const pool = createDatabasePool(config, logger);
  const executor = executorFor(pool);
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations'
  );

  try {
    if (command === 'migrate') {
      const result = await runMigrations(executor, migrationsDir, logger);
      logger.info({ applied: result.applied, skipped: result.skipped.length }, 'migrations complete');
      for (const v of result.applied) console.log(`applied: ${v}`);
      console.log(`skipped (already applied): ${result.skipped.length}`);
    } else if (command === 'verify') {
      const result = await verifyMigrations(executor, migrationsDir);
      if (result.ok) {
        console.log('all applied migrations verified OK');
      } else {
        console.error('MIGRATION INTEGRITY PROBLEMS:');
        for (const p of result.problems) console.error(`  - ${p}`);
        process.exitCode = 1;
      }
    } else {
      console.error(`unknown command: ${command} (expected 'migrate' or 'verify')`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('db cli failed:', err);
  process.exit(1);
});
