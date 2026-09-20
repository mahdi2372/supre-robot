import { Router } from 'express';
import { ah } from '../asyncHandler.js';
import type { ApiDeps } from '../app.js';
import { pingDatabase } from '../../database/pool.js';

export function systemRoutes(deps: ApiDeps): Router {
  const router = Router();

  router.get('/health', ah(async (_req, res) => {
    res.json({ status: 'ok', uptimeMs: process.uptime() * 1000, time: new Date().toISOString() });
  }));

  router.get('/status', ah(async (req, res) => {
    // Auth handled by middleware (session or admin API key).
    const dbCheck = deps.dbPool ? await pingDatabase(deps.dbPool) : { ok: false, ms: null };
    const snapshot = deps.statusSnapshot();
    res.json({
      version: deps.config.NODE_ENV === 'production' ? 'prod' : deps.config.NODE_ENV,
      bot: snapshot.bot,
      database: { connected: dbCheck.ok, lastPingMs: dbCheck.ms },
      modules: snapshot.modules,
      errors: snapshot.errors,
      commands: snapshot.commands
    });
  }));

  return router;
}
