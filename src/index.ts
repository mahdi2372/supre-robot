/**
 * Supre Robot — entrypoint.
 *
 * Boot order:
 *  1. validate environment (refuse to start on bad config)
 *  2. connect data layer (Postgres + optional Redis), run additive migrations
 *  3. build core services (settings, logging, scheduler, metrics, ui)
 *  4. boot modules in dependency order (failures isolated)
 *  5. register slash commands
 *  6. login to Discord gateway
 *  7. start the API/dashboard server
 *  8. graceful shutdown on SIGINT/SIGTERM
 */
import { Client, GatewayIntentBits } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { loadConfig } from './config/index.js';
import { createLogger } from './logging/logger.js';
import { createDatabasePool, executorFor, type Pool } from './database/pool.js';
import { runMigrations } from './database/migrate.js';
import { createCache } from './cache/index.js';
import { SettingsService } from './core/settings.js';
import { LogService } from './services/logService.js';
import { JobScheduler } from './jobs/scheduler.js';
import { registerJobHandlers } from './jobs/handlers.js';
import { Metrics } from './core/metrics.js';
import { ModuleManager } from './core/moduleManager.js';
import { UiRegistry } from './core/ui.js';
import { attachInteractionRouter } from './core/interactions.js';
import { registerCommands } from './commands/registerCommands.js';
import { createApiApp } from './api/app.js';
import { ALL_MODULES } from './modules/index.js';
import { findCustomCommandRow } from './modules/custom/lookup.js';
import { executeCustomCommand } from './modules/custom/executor.js';
import { translate } from './utils/i18n/index.js';
import { BOT_VERSION } from './modules/core/module.js';

// Module settings schemas (registered once, used by the settings service).
import { coreSettingsDefaults, coreSettingsSchema } from './modules/core/settings.js';
import { loggingSettingsDefaults, loggingSettingsSchema } from './modules/logging/settings.js';
import { welcomeSettingsDefaults, welcomeSettingsSchema } from './modules/welcome/settings.js';
import { moderationSettingsDefaults, moderationSettingsSchema } from './modules/moderation/settings.js';
import { automodSettingsDefaults, automodSettingsSchema } from './modules/automod/settings.js';
import { ticketsSettingsDefaults, ticketsSettingsSchema } from './modules/tickets/settings.js';
import { musicSettingsDefaults, musicSettingsSchema } from './modules/music/settings.js';

async function main(): Promise<void> {
  // 1. Configuration
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[supre] fatal: ${(err as Error).message}`);
    process.exit(1);
  }
  const logger = createLogger('supre', config.LOG_LEVEL, config.NODE_ENV !== 'production');
  logger.info({ version: BOT_VERSION, env: config.NODE_ENV }, 'booting Supre Robot');

  // 2. Data layer
  const pool: Pool = createDatabasePool(config, logger);
  const db = executorFor(pool);
  const { store: cache, kind: cacheKind } = await createCache(config, logger);

  const dbReachable = await (async () => {
    try {
      await db.query('SELECT 1');
      return true;
    } catch (err) {
      logger.error(
        { err: { message: err instanceof Error ? err.message : String(err) } },
        'database unreachable at boot — starting in DEGRADED mode (module state will be limited)'
      );
      return false;
    }
  })();

  if (config.DATABASE_AUTO_MIGRATE && dbReachable) {
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    try {
      const result = await runMigrations(db, migrationsDir, logger);
      logger.info({ applied: result.applied.length, skipped: result.skipped.length }, 'migrations complete');
    } catch (err) {
      logger.fatal({ err: { message: err instanceof Error ? err.message : String(err) } }, 'migration failed — aborting');
      await pool.end();
      process.exit(1);
    }
  }

  // 3. Core services
  const settings = new SettingsService(db, cache, logger);
  settings.register('core', { schema: coreSettingsSchema, defaults: coreSettingsDefaults });
  settings.register('logging', { schema: loggingSettingsSchema, defaults: loggingSettingsDefaults });
  settings.register('welcome', { schema: welcomeSettingsSchema, defaults: welcomeSettingsDefaults });
  settings.register('moderation', { schema: moderationSettingsSchema, defaults: moderationSettingsDefaults });
  settings.register('automod', { schema: automodSettingsSchema, defaults: automodSettingsDefaults });
  settings.register('tickets', { schema: ticketsSettingsSchema, defaults: ticketsSettingsDefaults });
  settings.register('music', { schema: musicSettingsSchema, defaults: musicSettingsDefaults });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildBans,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Music: the player tracks voice state changes (join/leave/empty
      // channel handling, auto-reconnect) through this intent.
      GatewayIntentBits.GuildVoiceStates
    ]
  });
  client.on('error', (err) => logger.error({ err: { message: err.message, name: err.name } }, 'discord client error'));
  client.on('warn', (msg) => logger.warn({ message: msg }, 'discord client warning'));

  const metrics = new Metrics();
  const ui = new UiRegistry();
  const logs = new LogService(db, client, settings, logger);
  const jobs = new JobScheduler(db, logger);
  registerJobHandlers(jobs, { client, config, db, logs, logger });

  const managerRef: { current: ModuleManager | null } = { current: null };
  const ctx = {
    client,
    config,
    db,
    cache,
    logger,
    settings,
    logs,
    jobs,
    metrics,
    ui,
    t: translate,
    moduleSnapshot: () => managerRef.current?.snapshot() ?? {}
  };
  const manager = new ModuleManager(ctx, logger);
  managerRef.current = manager;

  for (const mod of ALL_MODULES) manager.register(mod);

  attachInteractionRouter({
    ctx,
    manager,
    findCustomCommand: (guildId, name) => findCustomCommandRow(db, guildId, name),
    runCustomCommand: executeCustomCommand
  });

  // 4. Boot modules
  const { ready, failed } = await manager.startup();
  if (failed.length > 0) {
    logger.error({ failed }, 'some modules failed to start — continuing with the rest');
  }

  // Durable recurring jobs
  if (dbReachable) {
    await jobs
      .schedule({
        name: 'log-cleanup',
        type: 'log_cleanup',
        runsAt: new Date(Date.now() + 3_600_000),
        recurringMs: 24 * 3_600_000,
        payload: { retentionDays: config.LOG_RETENTION_DAYS }
      })
      .catch((err) => logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'could not schedule log cleanup'));
  }
  jobs.start();

  // 5. Slash commands + 6. Discord gateway
  // API-only mode runs just the web surface (no gateway, no commands) — an
  // ops convenience for debugging the dashboard/API or for API instances.
  if (config.API_ONLY) {
    logger.warn('API_ONLY=true — skipping Discord gateway login and command registration');
  } else {
    try {
      const result = await registerCommands(config, manager.commands(), logger);
      logger.info({ scope: result.scope, count: result.count }, 'commands registered');
    } catch (err) {
      logger.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'command registration failed — check token/permissions');
    }
    try {
      await client.login(config.DISCORD_TOKEN);
    } catch (err) {
      logger.fatal({ err: { message: err instanceof Error ? err.message : String(err) } }, 'discord login failed');
      await shutdown('discord login failed');
      process.exit(1);
    }
  }

  // 7. API + dashboard
  const app = createApiApp({
    config,
    logger,
    db,
    dbPool: pool,
    cache,
    settings,
    statusSnapshot: () => ({
      bot: {
        status: config.API_ONLY ? 'api-only' : client.isReady() ? 'ready' : 'starting',
        version: BOT_VERSION,
        uptimeMs: metrics.uptimeMs,
        latencyMs: client.ws.ping,
        username: client.user?.username ?? null,
        guildCount: client.guilds.cache.size
      },
      modules: manager.snapshot(),
      errors: metrics.snapshot(),
      commands: metrics.commandsSnapshot()
    }),
    moduleDescriptions: Object.fromEntries(ALL_MODULES.map((m) => [m.name, m.description ?? '']))
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(config.API_PORT, config.API_HOST, resolve));
  logger.info({ port: config.API_PORT, host: config.API_HOST, cache: cacheKind }, `API + dashboard listening on ${config.API_HOST}:${config.API_PORT}`);

  client.once('ready', () => {
    logger.info(
      {
        user: client.user?.tag,
        guilds: client.guilds.cache.size,
        modulesReady: ready,
        modulesFailed: failed
      },
      'ready'
    );
  });

  // 8. Graceful shutdown
  let shuttingDown = false;
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down…');
    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      server.close();
      jobs.stop();
      await manager.shutdown();
      await client.destroy();
      await Promise.allSettled([pool.end(), cache.close()]);
    } catch (err) {
      logger.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'error during shutdown');
    }
    logger.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: { message: reason instanceof Error ? reason.message : String(reason) } }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[supre] fatal boot error:', err);
  process.exit(1);
});
