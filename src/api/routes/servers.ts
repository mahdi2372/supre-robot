import { Router } from 'express';
import { ah } from '../asyncHandler.js';
import type { ApiDeps } from '../app.js';
import { SupreError } from '../../utils/errors.js';
import { sanitizeForLog } from '../../security/sanitize.js';
import { requireGuildManagement } from '../auth.js';

/**
 * Permission-aware server settings API.
 *
 * - the user can only ever see/touch guilds from THEIR OWN Discord session
 *   (resolved server-side from the OAuth fetch, never from client input);
 * - writes additionally require ManageGuild in that guild;
 * - every patch is merged over current settings and validated by the
 *   module's zod schema before touching the DB.
 */
export function serverRoutes(deps: ApiDeps): Router {
  const router = Router();

  router.get('/', ah(async (req, res) => {
    const user = req.sessionUser!;
    res.json({
      guilds: user.guilds.map((g) => ({
        id: g.id,
        name: g.name,
        owner: g.owner,
        icon: g.icon
      }))
    });
  }));

  router.get('/:guildId', ah(async (req, res) => {
    const user = req.sessionUser!;
    const guildId = req.params.guildId ?? '';
    const guild = user.guilds.find((g) => g.id === guildId);
    if (!guild) throw new SupreError('PERMISSION_DENIED', 'not a member of that server');

    const settingsRes = await deps.db.query<{ module_key: string; enabled: boolean; settings: string | Record<string, unknown> }>(
      'SELECT module_key, enabled, settings FROM guild_settings WHERE guild_id = $1',
      [guild.id]
    );
    const modules: Record<string, { enabled: boolean; settings: Record<string, unknown> }> = {};
    for (const name of deps.settings.knownModules()) {
      const row = settingsRes.rows.find((r) => r.module_key === name);
      const rawSettings = row?.settings;
      modules[name] = {
        enabled: row?.enabled ?? true,
        settings: rawSettings
          ? typeof rawSettings === 'string'
            ? JSON.parse(rawSettings)
            : rawSettings
          : {}
      };
    }

    const counts = await deps.db
      .query<{ open_tickets: number; open_cases: number; security_24h: number; logs_24h: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM tickets WHERE guild_id = $1 AND status = 'open') AS open_tickets,
           (SELECT COUNT(*)::int FROM moderation_cases WHERE guild_id = $1 AND status = 'active') AS open_cases,
           (SELECT COUNT(*)::int FROM security_events WHERE guild_id = $1 AND created_at > now() - interval '24 hours') AS security_24h,
           (SELECT COUNT(*)::int FROM bot_logs WHERE guild_id = $1 AND created_at > now() - interval '24 hours') AS logs_24h`,
        [guild.id]
      );
    const c = counts.rows[0] ?? { open_tickets: 0, open_cases: 0, security_24h: 0, logs_24h: 0 };

    res.json({ guild: { id: guild.id, name: guild.name, owner: guild.owner }, modules, stats: c });
  }));

  router.patch('/:guildId/modules/:module', requireGuildManagementFromParams, ah(async (req, res) => {
    const guildId = req.params.guildId ?? '';
    const module = (req.params.module ?? '').toLowerCase();
    const spec = deps.settings.getSchema(module);
    if (!spec) throw new SupreError('INVALID_INPUT', `unknown module: ${module}`);

    const body = (req.body ?? {}) as { enabled?: boolean; settings?: Record<string, unknown> };
    const user = req.sessionUser!;

    if (module === 'core' && body.enabled === false) {
      throw new SupreError('INVALID_INPUT', 'core module cannot be disabled');
    }

    if (typeof body.enabled === 'boolean') {
      await deps.settings.setEnabled(guildId, module, body.enabled, user.id);
    }
    let newSettings: Record<string, unknown> | undefined;
    if (body.settings && typeof body.settings === 'object') {
      newSettings = await deps.settings.set<Record<string, unknown>>(guildId, module, body.settings, user.id);
    }

    await deps.settings.ensureGuild(guildId, user.guilds.find((g) => g.id === guildId)?.name).catch(() => undefined);
    await deps.db
      .query(
        `INSERT INTO bot_logs (guild_id, kind, actor_id, data)
         VALUES ($1, 'config', $2, $3)
         ON CONFLICT DO NOTHING`,
        [guildId, user.id, JSON.stringify({ module, enabled: body.enabled, patched: Object.keys(body.settings ?? {}) })]
      )
      .catch(() => undefined);

    res.json({ ok: true, module, enabled: body.enabled, settings: newSettings });
  }));

  router.get('/:guildId/logs', requireGuildManagementFromParams, ah(async (req, res) => {
    const { guildId } = req.params;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const resRows = kind
      ? await deps.db.query<{
          id: string;
          kind: string;
          actor_id: string | null;
          target_id: string | null;
          data: string | Record<string, unknown>;
          created_at: Date;
        }>(
          'SELECT id, kind, actor_id, target_id, data, created_at FROM bot_logs WHERE guild_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT $3',
          [guildId, kind, limit]
        )
      : await deps.db.query<{
          id: string;
          kind: string;
          actor_id: string | null;
          target_id: string | null;
          data: string | Record<string, unknown>;
          created_at: Date;
        }>(
          'SELECT id, kind, actor_id, target_id, data, created_at FROM bot_logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
          [guildId, limit]
        );
    const rows = resRows.rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      actorId: r.actor_id,
      targetId: r.target_id,
      data: sanitizeForLog(typeof r.data === 'string' ? JSON.parse(r.data) : r.data),
      createdAt: r.created_at.toISOString()
    }));
    res.json({ logs: rows });
  }));

  return router;
}

function requireGuildManagementFromParams(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  requireGuildManagement(req.params.guildId ?? '')(req, res, next);
}
