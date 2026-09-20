import type { Client } from 'discord.js';
import type { JobScheduler } from './scheduler.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor } from '../types/index.js';
import type { LogService } from '../services/logService.js';

/**
 * Durable job handlers registered at boot.
 *
 * - punishment_expire: lifts timeouts / unbans when temporary punishments end
 * - log_cleanup: enforces LOG_RETENTION_DAYS on bot_logs
 * - temp_role_expire: removes temporary roles at their expiry
 *
 * Handlers depend on a narrow context (client/config/db/logs) so the
 * scheduler never needs the full ModuleContext.
 */
export interface JobHandlerContext {
  client: Client;
  config: AppConfig;
  db: QueryExecutor;
  logs: LogService;
  logger: Logger;
}

export function registerJobHandlers(scheduler: JobScheduler, ctx: JobHandlerContext): void {
  scheduler.register('punishment_expire', async (job) => {
    const { caseId, guildId, targetId, action } = job.payload as {
      caseId: number;
      guildId: string;
      targetId: string;
      action: 'untimeout' | 'unban';
    };
    if (!guildId || !targetId || typeof caseId !== 'number') {
      throw new Error('punishment_expire job missing payload fields');
    }
    const guild = ctx.client.guilds.cache.get(guildId) ?? null;
    if (!guild) throw new Error(`guild ${guildId} not in cache at job time`);

    if (action === 'untimeout') {
      const member = await guild.members.fetch(targetId).catch(() => null);
      if (member && member.communicationDisabledUntil) {
        await member.timeout(null, `Temporary punishment expired (case #${caseId})`);
      }
    } else if (action === 'unban') {
      await guild.members.unban(targetId, `Temporary ban expired (case #${caseId})`).catch((err) => {
        ctx.logger.warn(
          { err: { message: err instanceof Error ? err.message : String(err) }, targetId },
          'punishment_expire: unban failed (user may have been re-banned)'
        );
      });
    }

    await ctx.db.query(`UPDATE moderation_cases SET status = 'expired' WHERE guild_id = $1 AND case_number = $2`, [
      guildId,
      caseId
    ]);
    await ctx.logs.log({
      kind: 'mod_action',
      guildId,
      targetId,
      data: { action: `auto_expire_${action}`, case_number: caseId, reason: 'temporary punishment expired' }
    });
  });

  scheduler.register('log_cleanup', async () => {
    const days = ctx.config.LOG_RETENTION_DAYS;
    const res = await ctx.db.query<{ n: number }>(
      "DELETE FROM bot_logs WHERE created_at < now() - ($1 || ' days')::interval RETURNING id",
      [days]
    );
    const deleted = res.rows.length;
    if (deleted > 0) {
      ctx.logger.info({ deleted, retentionDays: days }, 'log retention cleanup complete');
    }
  });

  scheduler.register('temp_role_expire', async (job) => {
    const { guildId, roleId, targetId } = job.payload as { guildId: string; roleId: string; targetId: string };
    if (!guildId || !roleId || !targetId) throw new Error('temp_role_expire job missing payload fields');
    const guild = ctx.client.guilds.cache.get(guildId);
    if (!guild) return; // guild no longer available — nothing to do
    const member = await guild.members.fetch(targetId).catch(() => null);
    const role = guild.roles.cache.get(roleId);
    if (member && role && member.roles.cache.has(roleId)) {
      await member.roles.remove(role, 'temporary role expired').catch(() => undefined);
    }
  });
}
