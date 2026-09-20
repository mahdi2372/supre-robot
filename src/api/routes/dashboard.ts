import { Router, type NextFunction, type Request } from 'express';
import { ah } from '../asyncHandler.js';
import type { ApiDeps } from '../app.js';
import { SESSION_COOKIE, csrfTokenFor, hashToken } from '../auth.js';
import { pingDatabase } from '../../database/pool.js';
import { sanitizeForLog } from '../../security/sanitize.js';

/**
 * Minimal server-rendered dashboard (HTML forms, no client-side JS build).
 * Every mutation is a same-site POST form carrying a CSRF token derived
 * from the session; every page only shows guilds from the authenticated
 * user's own Discord session.
 */
export function dashboardRoutes(deps: ApiDeps): Router {
  const router = Router();
  const { logger } = deps;

  router.get('/', ah(async (req, res) => {
    const user = req.sessionUser!;
    const guildRows = user.guilds
      .map(
        (g) => `<tr>
          <td><a href="/dashboard/servers/${g.id}">${esc(g.name)}</a> ${g.owner ? '<span title="owner">👑</span>' : ''}</td>
          <td><code>${g.id}</code></td>
        </tr>`
      )
      .join('');
    res.type('html').send(layout('Servers', user.username, `
      <h2>Your servers</h2>
      <table class="tbl">${guildRows}</table>
    `));
  }));

  router.get('/servers/:guildId', ah(async (req, res) => {
    const user = req.sessionUser!;
    const guildId = req.params.guildId ?? '';
    const guild = user.guilds.find((g) => g.id === guildId);
    if (!guild) {
      res.status(403).send(layout('Forbidden', user.username, '<p>You do not manage this server.</p>'));
      return;
    }
    const canManage = guild.owner || BigInt(guild.permissions || '0') & 0x20n;

    const snap = deps.statusSnapshot();
    const dbCheck = deps.dbPool ? await pingDatabase(deps.dbPool) : { ok: false, ms: null };

    const moduleNames = deps.settings.knownModules();
    const enabledStates = await Promise.all(
      moduleNames.map(async (name) => {
        let enabled = true;
        try {
          enabled = name === 'core' || (await deps.settings.isEnabled(guildId, name));
        } catch {
          enabled = true;
        }
        return enabled;
      })
    );
    const modules = moduleNames
      .map((name, i) => {
        const enabled = enabledStates[i] ?? true;
        const info = snap.modules[name] ?? { status: 'unknown', version: '?' };
        const description = (deps.moduleDescriptions[name] ?? '').slice(0, 120);
        const token = sessionCsrf(req);
        const action = enabled ? 'disable' : 'enable';
        const toggleForm = canManage
          ? `<form method="post" action="/dashboard/servers/${guildId}/modules/${name}" style="display:inline">
              <input type="hidden" name="csrf" value="${token}">
              <input type="hidden" name="action" value="${action}">
              <button type="submit">${enabled ? 'Disable' : 'Enable'}</button>
            </form>`
          : '<span class="muted">read-only</span>';
        return `<tr>
          <td>${esc(name)}</td>
          <td>${info.status === 'ready' ? '✅ ready' : `❌ ${esc(info.status)}`}</td>
          <td>${enabled ? 'on' : 'off'}</td>
          <td class="muted">${esc(description)}</td>
          <td>${toggleForm}</td>
        </tr>`;
      })
      .join('');

    let logsHtml = '<p class="muted">No logs recorded yet.</p>';
    try {
      const rows = await deps.db.query<{
        kind: string;
        actor_id: string | null;
        target_id: string | null;
        data: string | Record<string, unknown>;
        created_at: Date;
      }>(
        'SELECT kind, actor_id, target_id, data, created_at FROM bot_logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 15',
        [guildId]
      );
      if (rows.rows.length > 0) {
        logsHtml = `<table class="tbl">${rows.rows
          .map((r) => {
            const data = sanitizeForLog(typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
            const summary =
              data.reason ?? data.change ?? data.action ?? (typeof data.content === 'string' ? data.content : '') ?? '';
            return `<tr>
              <td>${esc(r.created_at.toISOString().replace('T', ' ').slice(0, 19))}</td>
              <td>${esc(r.kind)}</td>
              <td class="muted">${esc(String(summary).slice(0, 80))}</td>
            </tr>`;
          })
          .join('')}</table>`;
      }
    } catch (err) {
      logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'dashboard logs failed');
    }

    res
      .type('html')
      .send(
        layout(`${guild.name}`, user.username, `
        <p class="muted">
          Bot: ${esc(snap.bot.username ?? '—')} • gateway ${snap.bot.latencyMs ?? '—'}ms •
          DB: ${dbCheck.ok ? `ok (${dbCheck.ms}ms)` : 'unreachable'} •
          errors (30m): ${snap.errors.last30Min}
        </p>
        <h2>Modules</h2>
        <table class="tbl">
          <thead><tr><th>module</th><th>runtime</th><th>server</th><th>description</th><th>toggle</th></tr></thead>
          ${modules}
        </table>
        <h2>Recent activity</h2>
        ${logsHtml}
      `)
      );
  }));

  router.post('/servers/:guildId/modules/:module', async (req, res, next: NextFunction) => {
    try {
      const user = req.sessionUser!;
      const guildId = req.params.guildId ?? '';
      const module = (req.params.module ?? '').toLowerCase();
      const guild = user.guilds.find((g) => g.id === guildId);
      if (!guild) throw new Error('not a member');
      const canManage = guild.owner || BigInt(guild.permissions || '0') & 0x20n;
      if (!canManage) throw new Error('insufficient permissions');

      // CSRF verification
      const expected = sessionCsrf(req);
      const provided = String(req.body?.csrf ?? '');
      if (!expected || provided !== expected) throw new Error('csrf mismatch');

      const action = String(req.body?.action ?? '');
      if (action !== 'enable' && action !== 'disable') throw new Error('bad action');
      if (module === 'core' && action === 'disable') throw new Error('core cannot be disabled');
      if (!deps.settings.getSchema(module)) throw new Error('unknown module');

      await deps.settings.setEnabled(guildId, module, action === 'enable', user.id);
      await deps.settings.ensureGuild(guildId, guild.name).catch(() => undefined);
      await deps.db
        .query('INSERT INTO bot_logs (guild_id, kind, actor_id, data) VALUES ($1, $2, $3, $4)', [
          guildId,
          'config',
          user.id,
          JSON.stringify({ module, change: action, surface: 'dashboard' })
        ])
        .catch(() => undefined);
      res.redirect(`/dashboard/servers/${guildId}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

let csrfSecret = '';
export function setCsrfSecret(secret: string): void {
  csrfSecret = secret;
}

function sessionCsrf(req: Request): string {
  const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
  if (!token) return '';
  // csrf = HMAC(secret, tokenHash) — deterministic, no extra storage.
  return csrfTokenFor(hashToken(token), csrfSecret);
}

function layout(title: string, user: string, body: string): string {
  const logoutForm = `<form method="post" action="/api/v1/auth/logout" style="float:right"><button type="submit">Sign out</button></form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supre Robot — ${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1000px; padding: 0 1rem; color: #dcddde; background: #1e1f22; }
  h1 { display: flex; justify-content: space-between; align-items: center; }
  h2 { border-bottom: 1px solid #41434a; padding-bottom: .3rem; }
  .tbl { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  .tbl th, .tbl td { border: 1px solid #41434a; padding: .5rem .7rem; text-align: left; }
  .tbl th { background: #2b2d31; }
  a { color: #00a8fc; text-decoration: none; }
  button { background: #5865f2; color: white; border: 0; padding: .4rem .9rem; border-radius: 4px; cursor: pointer; }
  .muted { color: #949ba4; font-size: .9rem; }
</style>
</head>
<body>
<h1>🤖 Supre Robot ${logoutForm}</h1>
<p class="muted">Signed in as ${esc(user)}</p>
${body}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
