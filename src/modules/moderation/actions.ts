import type { Guild, GuildMember } from 'discord.js';
import { SupreError } from '../../utils/errors.js';
import { canBotActOnTarget } from '../../core/permissions.js';
import type { ModuleContext } from '../../core/module.js';
import { formatDuration } from '../../utils/format.js';
import type { ModerationSettings } from './settings.js';

export type PunishmentType = 'warn' | 'ban' | 'kick' | 'timeout' | 'softban';

export interface PunishmentInput {
  ctx: ModuleContext;
  guild: Guild;
  target: GuildMember;
  type: PunishmentType;
  moderatorId: string;
  reason?: string;
  note?: string;
  evidence?: string;
  /** Timeout duration (ms). For ban: deleteMessageSeconds. */
  durationMs?: number;
  deleteMessageSeconds?: number;
  /** Set to false for automation triggers that should not open user-facing cases. */
  recordCase?: boolean;
}

export interface PunishmentResult {
  caseNumber: number | null;
  /** For warnings: the user's new warning count in the configured window. */
  warningCount?: number;
  /** Escalation that fired after a warning, if any. */
  escalation?: { action: 'timeout' | 'kick' | 'ban' };
}

/**
 * Single code path for every punishment — manual commands, AutoMod actions,
 * and automation rules all go through here, so case numbering, hierarchy
 * checks, expiry scheduling, and audit logging stay consistent.
 */
export async function executePunishment(input: PunishmentInput): Promise<PunishmentResult> {
  const { ctx, guild, target, type } = input;

  const me = guild.members.me;
  if (!me) throw new SupreError('INTERNAL', 'bot member not available');
  const botView = {
    user: { id: me.id },
    highestRole: { position: me.roles.highest.position },
    permissions: me.permissions
  };
  const targetView = {
    id: target.id,
    highestRole: { position: target.roles.highest.position },
    permissions: target.permissions
  };
  const hierarchy = canBotActOnTarget(botView, targetView, guild);
  if (!hierarchy.ok) {
    throw new SupreError('BOT_HIERARCHY', `cannot act on target (${hierarchy.reason})`);
  }
  if (target.id === ctx.client.user?.id) {
    throw new SupreError('INVALID_INPUT', 'the bot cannot punish itself');
  }

  // Persist guild row (FK target) before writing the case.
  await ctx.settings.ensureGuild(guild.id, guild.name);

  const settings = await ctx.settings.get<ModerationSettings>(guild.id, 'moderation');

  let caseNumber: number | null = null;
  let warningCount: number | null = null;
  let escalation: PunishmentResult['escalation'] = undefined;

  if (type === 'warn') {
    const count = await recordWarning(input, settings);
    warningCount = count;
    escalation = await maybeEscalate(input, count, settings);
  }

  // Expiry duration for the case (temporary punishments only).
  const expiresMs =
    type === 'timeout'
      ? input.durationMs ?? settings.defaultTimeoutMinutes * 60_000
      : type === 'ban'
        ? input.durationMs
        : undefined;

  if (input.recordCase !== false) {
    caseNumber = await openCase(input, expiresMs);
  }

  switch (type) {
    case 'warn':
      break;
    case 'kick':
      await target.kick(input.reason).catch((err) => {
        throw toApiError(err);
      });
      break;
    case 'ban':
      await guild.members
        .ban(target.id, { reason: input.reason, deleteMessageSeconds: input.deleteMessageSeconds ?? 0 })
        .catch((err) => {
          throw toApiError(err);
        });
      break;
    case 'timeout': {
      const ms = input.durationMs ?? settings.defaultTimeoutMinutes * 60_000;
      if (ms > 28 * 24 * 3600 * 1000) {
        throw new SupreError('INVALID_INPUT', 'timeout duration cannot exceed 28 days');
      }
      await target.timeout(ms, input.reason).catch((err) => {
        throw toApiError(err);
      });
      break;
    }
    case 'softban':
      await guild.members
        .ban(target.id, { reason: input.reason ?? 'softban', deleteMessageSeconds: 86400 })
        .catch((err) => {
          throw toApiError(err);
        });
      await guild.members.unban(target.id, `softban release: ${input.reason ?? ''}`).catch((err) => {
        ctx.logger.warn(
          { err: { message: err instanceof Error ? err.message : String(err) }, targetId: target.id },
          'softban: user could not be unbanned (join requirements may block re-join)'
        );
      });
      break;
  }

  // Temporary punishments get a durable expiry job so they survive restarts.
  if (caseNumber !== null && expiresMs && type === 'timeout') {
    await ctx.jobs.schedule({
      name: `timeout-expire:${caseNumber}`,
      type: 'punishment_expire',
      guildId: guild.id,
      payload: { caseId: caseNumber, guildId: guild.id, targetId: target.id, action: 'untimeout' },
      runsAt: new Date(Date.now() + expiresMs)
    });
  }
  if (caseNumber !== null && type === 'ban' && input.durationMs) {
    await ctx.jobs.schedule({
      name: `ban-expire:${caseNumber}`,
      type: 'punishment_expire',
      guildId: guild.id,
      payload: { caseId: caseNumber, guildId: guild.id, targetId: target.id, action: 'unban' },
      runsAt: new Date(Date.now() + input.durationMs)
    });
  }

  await ctx.logs.log({
    kind: 'mod_action',
    guildId: guild.id,
    actorId: input.moderatorId,
    targetId: target.id,
    data: {
      action: type,
      case_number: caseNumber,
      target: `${target.displayName} (${target.id})`,
      moderator: input.moderatorId,
      reason: input.reason ?? '',
      duration: expiresMs ? formatDuration(expiresMs) : null
    }
  });

  return { caseNumber, warningCount: warningCount ?? undefined, escalation };
}

async function recordWarning(input: PunishmentInput, settings: ModerationSettings): Promise<number> {
  const { ctx, guild, target } = input;
  const windowDays = settings.warnWindowDays;

  return await ctx.db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO servers (guild_id, name) VALUES ($1, $1) ON CONFLICT (guild_id) DO NOTHING',
      [guild.id]
    );
    const nextCase = (await tx.query<{ n: number }>(
      'UPDATE servers SET case_counter = case_counter + 1 WHERE guild_id = $1 RETURNING case_counter AS n',
      [guild.id]
    )).rows[0]?.n;

    await tx.query(
      `INSERT INTO users (discord_id, username) VALUES ($1, $2)
       ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username`,
      [target.id, target.displayName]
    );
    await tx.query(
      `INSERT INTO warnings (guild_id, user_id, moderator_id, case_id, reason, note, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [guild.id, target.id, input.moderatorId, nextCase, input.reason ?? '', input.note ?? null, input.evidence ?? null]
    );
    await tx.query(
      `INSERT INTO moderation_cases (guild_id, case_number, type, target_id, moderator_id, reason, note, evidence)
       VALUES ($1, $2, 'warn', $3, $4, $5, $6, $7)`,
      [guild.id, nextCase, target.id, input.moderatorId, input.reason ?? '', input.note ?? null, input.evidence ?? null]
    );

    const countRes = await tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM warnings
       WHERE guild_id = $1 AND user_id = $2 AND created_at > now() - ($3 || ' days')::interval`,
      [guild.id, target.id, windowDays]
    );
    return countRes.rows[0]?.n ?? 1;
  });
}

async function openCase(input: PunishmentInput, durationMs?: number): Promise<number> {
  const { ctx, guild, target, type } = input;
  return await ctx.db.transaction(async (tx) => {
    const caseRes = await tx.query<{ n: number }>(
      'UPDATE servers SET case_counter = case_counter + 1 WHERE guild_id = $1 RETURNING case_counter AS n',
      [guild.id]
    );
    const caseNumber = caseRes.rows[0]?.n ?? 1;
    const expiresAt = durationMs ? new Date(Date.now() + durationMs) : null;
    await tx.query(
      `INSERT INTO moderation_cases (guild_id, case_number, type, target_id, moderator_id, reason, note, evidence, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [guild.id, caseNumber, type, target.id, input.moderatorId, input.reason ?? '', input.note ?? null, input.evidence ?? null, expiresAt]
    );
    return caseNumber;
  });
}

/**
 * Escalation ladder: when the user's windowed warning count exactly matches
 * a step, that step's punishment is applied once (recorded as a case by the
 * original moderator, marked automated in the reason).
 */
async function maybeEscalate(
  input: PunishmentInput,
  warningCount: number,
  settings: ModerationSettings
): Promise<PunishmentResult['escalation']> {
  const step = settings.escalation.find((s) => s.warnings === warningCount);
  if (!step) return undefined;

  const { ctx, guild, target } = input;
  const reason = `Auto-escalation after ${warningCount} warnings (rule: ${step.warnings} → ${step.action})`;

  const result = await executePunishment({
    ctx,
    guild,
    target,
    type: step.action,
    moderatorId: input.moderatorId,
    reason,
    durationMs: step.durationMinutes ? step.durationMinutes * 60_000 : undefined,
    recordCase: true
  });

  await ctx.logs.log({
    kind: 'mod_action',
    guildId: guild.id,
    actorId: input.moderatorId,
    targetId: target.id,
    data: {
      action: `escalation_${step.action}`,
      case_number: result.caseNumber,
      target: target.id,
      reason
    }
  });

  return { action: step.action };
}

function toApiError(err: unknown): SupreError {
  const raw = (err as { code?: number })?.code;
  if (raw === 50035 || raw === 10007) return new SupreError('NOT_IN_GUILD', 'target is not in this server');
  if (raw === 10015) return new SupreError('BOT_HIERARCHY', 'target is above the bot');
  if (raw === 403 || raw === 50013) return new SupreError('PERMISSION_DENIED', 'missing permission for this action');
  return new SupreError('DISCORD_API', 'failed to apply punishment');
}
