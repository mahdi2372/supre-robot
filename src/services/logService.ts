import { EmbedBuilder, TextChannel } from 'discord.js';
import type { Client } from 'discord.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor } from '../types/index.js';
import type { SettingsService } from '../core/settings.js';
import { sanitizeForLog, safeSideEffect } from '../security/sanitize.js';
import type { LoggingSettings } from '../modules/logging/settings.js';

export const LOG_KINDS = [
  'member_join',
  'member_leave',
  'message_delete',
  'message_edit',
  'mod_action',
  'role_change',
  'channel_change',
  'guild_change',
  'ticket',
  'music',
  'giveaway',
  'verification',
  'security',
  'config',
  'error'
] as const;

export type LogKind = (typeof LOG_KINDS)[number];

export interface LogEntry {
  kind: LogKind;
  guildId: string;
  actorId?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}

/**
 * Bot-side audit logging:
 *  1. every entry is sanitized (secrets redacted) and persisted to bot_logs;
 *  2. if the guild configured a log channel for that kind (or the default
 *     channel), an embed is sent — best effort, never throws.
 *
 * Log retention: a scheduled job (log_cleanup) deletes rows older than
 * LOG_RETENTION_DAYS. See src/jobs/handlers.ts.
 */
export class LogService {
  constructor(
    private readonly db: QueryExecutor,
    private readonly client: Client,
    private readonly settings: SettingsService,
    private readonly logger: Logger
  ) {}

  async log(entry: LogEntry): Promise<void> {
    const safeData = sanitizeForLog(entry.data ?? {}) as Record<string, unknown>;
    const safe: LogEntry = {
      kind: entry.kind,
      guildId: entry.guildId,
      actorId: entry.actorId,
      targetId: entry.targetId,
      data: safeData
    };

    await this.db.query(
      `INSERT INTO bot_logs (guild_id, kind, actor_id, target_id, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [safe.guildId, safe.kind, safe.actorId ?? null, safe.targetId ?? null, JSON.stringify(safeData)]
    );
    this.logger.debug({ kind: safe.kind, guildId: safe.guildId }, 'bot log entry written');

    await this.deliverToChannel(safe);
  }

  private async deliverToChannel(entry: LogEntry): Promise<void> {
    await safeSideEffect(async () => {
      const s = await this.settings.get<LoggingSettings>(entry.guildId, 'logging');
      if (!s.enabledKinds[entry.kind]) return;

      const channelId = s.channels[entry.kind] ?? s.defaultChannelId;
      if (!channelId) return;
      const guild = this.client.guilds.cache.get(entry.guildId);
      if (!guild) return;
      const channel = guild.channels.cache.get(channelId);
      if (!(channel instanceof TextChannel)) return;

      const embed = this.buildEmbed(guild.name ?? entry.guildId, entry);
      await channel.send({ embeds: [embed] });
    }, (err) => {
      this.logger.warn({ err: { message: (err as Error).message }, kind: entry.kind }, 'log delivery failed');
    });
  }

  private buildEmbed(guildName: string, entry: LogEntry): EmbedBuilder {
    const data: Record<string, unknown> = entry.data ?? {};
    const base = new EmbedBuilder()
      .setColor(0x5865f2)
      .setFooter({ text: `${guildName} • ${entry.kind}` })
      .setTimestamp();

    switch (entry.kind) {
      case 'member_join':
        base
          .setTitle('👤 Member joined')
          .setDescription(`**${str(data.user_name)}** (\`${str(data.user_id)}\`)`)
          .addFields(
            { name: 'Account age', value: str(data.account_age) ?? '—', inline: true },
            { name: 'Inviter', value: str(data.inviter) ?? '—', inline: true }
          );
        break;
      case 'member_leave':
        base
          .setTitle('👤 Member left')
          .setDescription(`**${str(data.user_name)}** (\`${str(data.user_id)}\`)`);
        break;
      case 'message_delete':
        base
          .setTitle('🗑️ Message deleted')
          .setDescription(
            [
              `**Channel:** ${str(data.channel) ?? 'unknown'}`,
              `**Author:** ${str(data.author) ?? 'unknown'}`,
              `**Content:** ${truncate(str(data.content) ?? '(unavailable)', 500)}`
            ].join('\n')
          );
        break;
      case 'message_edit':
        base
          .setTitle('✏️ Message edited')
          .setDescription(
            [
              `**Channel:** ${str(data.channel) ?? 'unknown'}`,
              `**Before:** ${truncate(str(data.before) ?? '(unavailable)', 300)}`,
              `**After:** ${truncate(str(data.after) ?? '(unavailable)', 300)}`
            ].join('\n')
          );
        break;
      case 'mod_action':
        base
          .setTitle(`🛡️ Moderation: ${str(data.action) ?? 'action'}`)
          .setDescription(
            [
              `**Case:** #${str(data.case_number) ?? '?'}`,
              `**Target:** ${str(data.target) ?? 'unknown'}`,
              `**Moderator:** ${str(data.moderator) ?? 'automated'}`,
              `**Reason:** ${truncate(str(data.reason) ?? '—', 500)}`
            ].join('\n')
          );
        break;
      case 'security':
        base
          .setTitle(`🚨 Security event: ${str(data.kind) ?? 'event'}`)
          .setDescription(`Severity: **${str(data.severity) ?? 'info'}**\n${truncate(JSON.stringify(data, null, 2).replace(/"REDACTED"/g, '[redacted]'), 500)}`);
        break;
      default:
        base
          .setTitle(`📋 ${entry.kind.replace(/_/g, ' ')}`)
          .setDescription(truncate(JSON.stringify(data), 900));
    }
    return base;
  }
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
