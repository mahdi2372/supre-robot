import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor, SystemStatusSnapshot } from '../types/index.js';
import type { CacheStore } from '../cache/types.js';
import type { SettingsService } from '../core/settings.js';
import type { Pool } from '../database/pool.js';
import {
  SESSION_COOKIE,
  apiKeyOrSession,
  createAuthMiddleware,
  discordAuthorizeUrl,
  destroySession,
  handleOAuthCallback,
  requireSession,
  sessionCookieOptions,
  withStateCache
} from './auth.js';
import { ah } from './asyncHandler.js';
import { createApiErrorHandler, createApiLoggerMiddleware, notFoundHandler, requestIdMiddleware } from './middleware.js';
import { systemRoutes } from './routes/system.js';
import { serverRoutes } from './routes/servers.js';
import { dashboardRoutes, setCsrfSecret } from './routes/dashboard.js';

export interface ApiDeps {
  config: AppConfig;
  logger: Logger;
  db: QueryExecutor;
  dbPool: Pool;
  cache: CacheStore;
  settings: SettingsService;
  /** Live status snapshot from the bot core (metrics + module manager). */
  statusSnapshot: () => Omit<SystemStatusSnapshot, 'database'>;
  moduleDescriptions: Record<string, string>;
}

/**
 * Express app factory — pure dependency injection so the API is fully
 * testable with supertest (no Discord client, no live DB needed for the
 * health route).
 */
export function createApiApp(deps: ApiDeps): Express {
  const app = express();
  const { config, logger, db, cache } = deps;

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(createApiLoggerMiddleware(logger));

  // CORS: same-origin only (dashboard is served from this app).
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || origin.startsWith(config.PUBLIC_BASE_URL)) return cb(null, true);
        return cb(null, false);
      }
    })
  );

  // Rate limiting (per IP).
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.REQUEST_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'rate limit exceeded' } }
    })
  );
  app.use(
    '/dashboard',
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false
    })
  );

  setCsrfSecret(config.SESSION_SECRET);
  const auth = createAuthMiddleware(db, logger);
  app.use(auth);

  // ---------- v1 API ----------
  // All versioned routes live under /api/v1 (including OAuth, whose redirect
  // URIs must match the Discord application's registered callback).
  const api = express.Router();
  const v1 = express.Router();

  // OAuth2 (login / callback / logout)
  v1.get('/auth/login', ah(async (req, res) => {
    const states = withStateCache(cache);
    const state = await states.issue();
    res.redirect(discordAuthorizeUrl(config, state));
  }));
  v1.get('/auth/callback', (req, res, next) => {
    handleOAuthCallback(config, db, cache, logger, req, res).catch(next);
  });
  v1.post('/auth/logout', ah(async (req, res) => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    await destroySession(db, token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    res.redirect('/api/v1/auth/login');
  }));

  // /v1/status is semi-public: it requires an admin API key or a session
  // (unlike the session-only /servers routes). Health stays fully public.
  v1.use('/status', apiKeyOrSession(config));
  v1.use('/', systemRoutes(deps));
  v1.use('/servers', requireSession, serverRoutes(deps));

  api.use('/v1', v1);
  app.use('/api', api);

  // ---------- Dashboard (HTML) ----------
  app.use('/dashboard', requireSession, dashboardRoutes(deps));
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard');
  });

  // 404 + centralized errors (must be last)
  app.use(notFoundHandler);
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    createApiErrorHandler(logger, db)(err, req, res, _next);
  });

  return app;
}
