import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import type { QueryExecutor } from '../types/index.js';
import type { CacheStore } from '../cache/types.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import { SupreError } from '../utils/errors.js';

export interface GuildSummary {
  id: string;
  name: string;
  /** Discord permission bitfield for the user in this guild (decimal string). */
  permissions: string;
  owner: boolean;
  icon: string | null;
}

export interface SessionUser {
  id: string;
  username: string;
  avatar: string | null;
  guilds: GuildSummary[];
}

export const SESSION_COOKIE = 'supre_session';
const SESSION_TTL_DAYS = 7;
const MANAGE_GUILD_BIT = 0x20n;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function csrfTokenFor(tokenHash: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${tokenHash}`).digest('hex').slice(0, 40);
}

// ---------- session store (DB-backed) ----------

export async function createSession(
  db: QueryExecutor,
  user: SessionUser
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await db.query(
    `INSERT INTO dashboard_sessions (token_hash, discord_id, username, avatar, guilds, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (token_hash) DO UPDATE SET
       guilds = EXCLUDED.guilds, expires_at = EXCLUDED.expires_at, last_seen_at = now()`,
    [hashToken(token), user.id, user.username, user.avatar, JSON.stringify(user.guilds), expiresAt]
  );
  return { token, expiresAt };
}

export async function getSession(
  db: QueryExecutor,
  token: string | undefined
): Promise<SessionUser | null> {
  if (!token) return null;
  const res = await db.query<{
    discord_id: string;
    username: string;
    avatar: string | null;
    guilds: string | GuildSummary[];
    expires_at: Date;
  }>('SELECT discord_id, username, avatar, guilds, expires_at FROM dashboard_sessions WHERE token_hash = $1', [
    hashToken(token)
  ]);
  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  void db
    .query('UPDATE dashboard_sessions SET last_seen_at = now() WHERE token_hash = $1', [hashToken(token)])
    .catch(() => undefined);
  const guilds = typeof row.guilds === 'string' ? JSON.parse(row.guilds) : row.guilds;
  return {
    id: row.discord_id,
    username: row.username,
    avatar: row.avatar,
    guilds
  };
}

export async function destroySession(db: QueryExecutor, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [hashToken(token)]).catch(() => undefined);
}

// ---------- OAuth2 (code exchange) ----------

export function discordAuthorizeUrl(config: AppConfig, state: string): string {
  const redirectUri = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/v1/auth/callback`;
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(config: AppConfig, code: string): Promise<string> {
  const redirectUri = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/v1/auth/callback`;
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  if (!res.ok) {
    throw new SupreError('DISCORD_API', `oauth token exchange failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function fetchDiscordUser(accessToken: string): Promise<SessionUser> {
  const meRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!meRes.ok) throw new SupreError('DISCORD_API', 'failed to fetch user');
  const me = (await meRes.json()) as { id: string; username: string; avatar: string | null };

  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!guildsRes.ok) throw new SupreError('DISCORD_API', 'failed to fetch guilds');
  const rawGuilds = (await guildsRes.json()) as Array<{
    id: string;
    name: string;
    permissions: string;
    owner: boolean;
    icon: string | null;
  }>;

  return {
    id: me.id,
    username: me.username,
    avatar: me.avatar,
    guilds: rawGuilds.map((g) => ({
      id: g.id,
      name: g.name,
      permissions: g.permissions,
      owner: g.owner,
      icon: g.icon
    }))
  };
}

// ---------- middleware ----------

export function createAuthMiddleware(db: QueryExecutor, logger: Logger) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = (req.cookies as Record<string, string | undefined>)?.[SESSION_COOKIE];
      req.sessionUser = await getSession(db, token);
      next();
    } catch (err) {
      logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'session lookup failed');
      req.sessionUser = null;
      next();
    }
  };
}

/** Require an authenticated dashboard session; 401 for JSON API, redirect for pages. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (req.sessionUser) {
    next();
    return;
  }
  // Anything under /api is a JSON API: always answer 401, never redirect.
  // (Browsers hitting /api/* get JSON; the dashboard under /dashboard redirects.)
  // originalUrl is not rewritten by sub-routers, unlike req.path/req.url.
  if (req.originalUrl.startsWith('/api')) {
    res.status(401).json({ error: { code: 'PERMISSION_DENIED', message: 'authentication required' } });
    return;
  }
  if (req.accepts('html')) {
    res.redirect('/api/v1/auth/login');
    return;
  }
  res.status(401).json({ error: { code: 'PERMISSION_DENIED', message: 'authentication required' } });
}

/** Require ManageGuild (or ownership) in the target guild. */
export function requireGuildManagement(guildId: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.sessionUser;
    if (!user) {
      res.status(401).json({ error: { code: 'PERMISSION_DENIED', message: 'authentication required' } });
      return;
    }
    const guild = user.guilds.find((g) => g.id === guildId);
    if (!guild) {
      res.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'not a member of that server' } });
      return;
    }
    const bits = BigInt(guild.permissions || '0');
    if (!guild.owner && !(bits & MANAGE_GUILD_BIT)) {
      res.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'ManageGuild permission required' } });
      return;
    }
    next();
  };
}

/**
 * Admin API key (X-Api-Key) or an authenticated dashboard session.
 * Mounted on /api/v1/status so uptime monitors and ops tooling can use a
 * shared key instead of a cookie.
 */
export function apiKeyOrSession(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['x-api-key'];
    const keyOk = !!config.ADMIN_API_KEY && typeof header === 'string' && constantTimeEquals(header, config.ADMIN_API_KEY);
    if (keyOk || req.sessionUser) {
      next();
      return;
    }
    res.status(401).json({ error: { code: 'PERMISSION_DENIED', message: 'authentication required' } });
  };
}

/** Constant-time string comparison (hashes first, so lengths don't leak). */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_TTL_DAYS * 86400_000
};

export function withStateCache(cache: CacheStore) {
  const STATES_TTL = 10 * 60; // seconds
  return {
    async issue(): Promise<string> {
      const state = randomBytes(16).toString('hex');
      await cache.set(`oauth_state:${state}`, '1', STATES_TTL);
      return state;
    },
    async consume(state: string | undefined): Promise<boolean> {
      if (!state) return false;
      const key = `oauth_state:${state}`;
      const val = await cache.get(key);
      if (val === undefined) return false;
      await cache.del(key);
      return true;
    }
  };
}

/** OAuth login/callback/logout route handlers. */
export async function handleOAuthCallback(
  config: AppConfig,
  db: QueryExecutor,
  cache: CacheStore,
  logger: Logger,
  req: Request,
  res: Response
): Promise<void> {
  const code = (req.query.code as string | undefined) ?? '';
  const state = (req.query.state as string | undefined) ?? '';
  const states = withStateCache(cache);

  if (!code) {
    res.redirect('/dashboard?error=missing_code');
    return;
  }
  if (!(await states.consume(state))) {
    logger.warn('oauth callback with invalid state — possible CSRF');
    res.redirect('/dashboard?error=invalid_state');
    return;
  }

  const accessToken = await exchangeCode(config, code);
  const user = await fetchDiscordUser(accessToken);
  const { token } = await createSession(db, user);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
  logger.info({ userId: user.id, guilds: user.guilds.length }, 'dashboard session created');
  res.redirect('/dashboard');
}
