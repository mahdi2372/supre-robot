import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type Channel,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type GuildMember
} from 'discord.js';
import type { SupreCommand } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';
import { formatDuration } from '../../utils/format.js';
import { executePunishment } from './actions.js';
import type { ModerationSettings } from './settings.js';

const MAX_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

async function requireGuildMember(interaction: ChatInputCommandInteraction, name: string): Promise<GuildMember> {
  const guild = interaction.guild;
  if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
  const user = interaction.options.getUser(name);
  if (!user) throw new SupreError('INVALID_INPUT', `missing ${name}`);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) throw new SupreError('NOT_IN_GUILD', 'target is not a member');
  return member;
}

async function localeOf(ctx: Parameters<SupreCommand['run']>[0], interaction: ChatInputCommandInteraction): Promise<string> {
  if (!interaction.guild) return 'en';
  try {
    return (await ctx.settings.get<{ locale?: string }>(interaction.guild.id, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}

function toApiError(err: unknown, fallback: string): SupreError {
  const code = (err as { code?: number })?.code;
  if (code === 50035 || code === 10007) return new SupreError('NOT_IN_GUILD', 'target is not in this server');
  if (code === 10015) return new SupreError('BOT_HIERARCHY', 'target is above the bot');
  if (code === 403 || code === 50013) return new SupreError('PERMISSION_DENIED', 'missing permission');
  return new SupreError('DISCORD_API', fallback);
}

/**
 * Moderation commands. All punishments flow through executePunishment
 * (hierarchy checks, case numbering, expiry jobs, audit logs).
 */
export const moderationCommands: SupreCommand[] = [
  {
    module: 'moderation',
    name: 'warn',
    description: 'Warn a member (notes + evidence, triggers escalation ladder)',
    requiredPermission: 'ModerateMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User to warn').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason shown in the warning').setRequired(true).setMaxLength(500))
        .addStringOption((o) => o.setName('note').setDescription('Private moderator note').setMaxLength(1000))
        .addAttachmentOption((o) => o.setName('evidence').setDescription('Evidence attachment'));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const reason = interaction.options.getString('reason', true) ?? '';
      const note = interaction.options.getString('note') ?? undefined;
      const attachment = interaction.options.getAttachment('evidence');
      const evidence = attachment?.url;

      const result = await executePunishment({
        ctx,
        guild,
        target,
        type: 'warn',
        moderatorId: interaction.user.id,
        reason,
        note,
        evidence
      });

      const loc = await localeOf(ctx, interaction);
      let msg = translate(loc, 'mod.warn_added', {
        user: `<@${target.id}>`,
        case: result.caseNumber ?? 0,
        reason
      });
      if (result.escalation && result.warningCount) {
        msg += `\n${translate(loc, 'mod.warn_escalated', {
          action: result.escalation.action,
          count: result.warningCount
        })}`;
      }
      if (evidence) msg += `\n${translate(loc, 'mod.evidence_attached')}`;
      await interaction.reply({ content: msg, ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'warnings',
    description: 'Show a member’s warnings in the current window',
    requiredPermission: 'ModerateMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User').setRequired(true));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const loc = await localeOf(ctx, interaction);
      const s = await ctx.settings.get<ModerationSettings>(guild.id, 'moderation');

      const rows = await ctx.db.query<{
        reason: string;
        moderator_id: string;
        case_id: number;
        created_at: Date;
      }>(
        `SELECT reason, moderator_id, case_id, created_at
         FROM warnings
         WHERE guild_id = $1 AND user_id = $2
           AND created_at > now() - ($3 || ' days')::interval
         ORDER BY created_at DESC LIMIT 10`,
        [guild.id, target.id, s.warnWindowDays]
      );

      if (rows.rows.length === 0) {
        await interaction.reply({
          content: translate(loc, 'mod.warnings_none', { user: `<@${target.id}>` }),
          ephemeral: true
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(translate(loc, 'mod.warnings_title', { user: target.displayName }))
        .setColor(0xfee75c)
        .setDescription(
          rows.rows
            .map((r) => `**#${r.case_id}** — ${r.reason}\nModerator: <@${r.moderator_id}> • ${r.created_at.toISOString()}`)
            .join('\n\n')
        )
        .setFooter({ text: `${rows.rows.length} warning(s) in the last ${s.warnWindowDays} days` });
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'ban',
    description: 'Ban a member (supports temporary bans + message deletion)',
    requiredPermission: 'BanMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500))
        .addIntegerOption((o) => o.setName('delete-days').setDescription('Delete messages from the last N days (0-7)').setMinValue(0).setMaxValue(7))
        .addIntegerOption((o) => o.setName('temp-hours').setDescription('Temporary ban duration in hours (max 672)').setMinValue(1).setMaxValue(672));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const reason = interaction.options.getString('reason', true) ?? '';
      const deleteDays = interaction.options.getInteger('delete-days') ?? 0;
      const tempHours = interaction.options.getInteger('temp-hours') ?? undefined;
      const loc = await localeOf(ctx, interaction);

      const result = await executePunishment({
        ctx,
        guild,
        target,
        type: 'ban',
        moderatorId: interaction.user.id,
        reason,
        deleteMessageSeconds: deleteDays > 0 ? deleteDays * 86400 : undefined,
        durationMs: tempHours ? tempHours * 3600 * 1000 : undefined
      });

      let msg = translate(loc, 'mod.ban_applied', { user: target.displayName, case: result.caseNumber ?? 0, reason });
      if (tempHours) {
        msg += `\n${translate(loc, 'mod.temp_note', { duration: formatDuration(tempHours * 3600 * 1000) })}`;
      }
      await interaction.reply({ content: msg, ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'unban',
    description: 'Unban a user by ID or tag',
    requiredPermission: 'BanMembers',
    configure(b: SlashCommandBuilder) {
      b.addStringOption((o) => o.setName('user').setDescription('User ID or tag').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const raw = interaction.options.getString('user', true) ?? '';
      const reason = interaction.options.getString('reason', true) ?? '';
      const loc = await localeOf(ctx, interaction);

      let targetId = raw;
      if (!/^\d{10,20}$/.test(raw)) {
        const bans = await guild.bans.fetch().catch(() => new Map<string, { user: { id: string; tag?: string; username?: string } }>());
        const found = [...bans.values()].find((b) => b.user.tag === raw || b.user.username?.toLowerCase() === raw.toLowerCase());
        if (!found) throw new SupreError('INVALID_INPUT', 'no banned user matches that ID or tag');
        targetId = found.user.id;
      }

      await guild.members.unban(targetId, reason).catch((err) => {
        throw toApiError(err, 'unban failed');
      });

      await ctx.logs.log({
        kind: 'mod_action',
        guildId: guild.id,
        actorId: interaction.user.id,
        targetId,
        data: { action: 'unban', target: targetId, moderator: interaction.user.id, reason }
      });
      await interaction.reply({ content: translate(loc, 'mod.ban_removed', { user: raw, reason }), ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'kick',
    description: 'Kick a member',
    requiredPermission: 'KickMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User to kick').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const reason = interaction.options.getString('reason', true) ?? '';
      const loc = await localeOf(ctx, interaction);
      const result = await executePunishment({
        ctx,
        guild,
        target,
        type: 'kick',
        moderatorId: interaction.user.id,
        reason
      });
      await interaction.reply({
        content: translate(loc, 'mod.kick_applied', { user: target.displayName, case: result.caseNumber ?? 0, reason }),
        ephemeral: true
      });
    }
  },
  {
    module: 'moderation',
    name: 'timeout',
    description: 'Timeout a member (omit minutes to remove an existing timeout)',
    requiredPermission: 'ModerateMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User to timeout').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(500))
        .addIntegerOption((o) => o.setName('minutes').setDescription('Duration in minutes (max 40320 = 28 days)').setMinValue(1).setMaxValue(40320));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const reason = interaction.options.getString('reason') ?? undefined;
      const minutes = interaction.options.getInteger('minutes') ?? undefined;
      const loc = await localeOf(ctx, interaction);

      if (minutes === undefined) {
        if (!target.communicationDisabledUntil) {
          throw new SupreError('INVALID_INPUT', 'that user is not timed out');
        }
        await target.timeout(null, reason).catch((err) => {
          throw toApiError(err, 'timeout removal failed');
        });
        await ctx.logs.log({
          kind: 'mod_action',
          guildId: guild.id,
          actorId: interaction.user.id,
          targetId: target.id,
          data: { action: 'untimeout', target: target.id, moderator: interaction.user.id, reason: reason ?? '' }
        });
        await interaction.reply({ content: translate(loc, 'mod.timeout_removed', { user: `<@${target.id}>` }), ephemeral: true });
        return;
      }

      const ms = minutes * 60_000;
      const result = await executePunishment({
        ctx,
        guild,
        target,
        type: 'timeout',
        moderatorId: interaction.user.id,
        reason: reason ?? '',
        durationMs: ms
      });
      const msg =
        translate(loc, 'mod.timeout_applied', {
          user: `<@${target.id}>`,
          duration: formatDuration(ms),
          case: result.caseNumber ?? 0,
          reason: reason ?? ''
        }) +
        `\n${translate(loc, 'mod.temp_note', { duration: formatDuration(ms) })}`;
      await interaction.reply({ content: msg, ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'softban',
    description: 'Ban and immediately unban (deletes the last 24h of messages)',
    requiredPermission: 'BanMembers',
    configure(b: SlashCommandBuilder) {
      b.addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const target = await requireGuildMember(interaction, 'user');
      const reason = interaction.options.getString('reason', true) ?? '';
      const loc = await localeOf(ctx, interaction);
      const result = await executePunishment({
        ctx,
        guild,
        target,
        type: 'softban',
        moderatorId: interaction.user.id,
        reason
      });
      await interaction.reply({
        content: translate(loc, 'mod.softban_applied', { user: target.displayName, case: result.caseNumber ?? 0 }),
        ephemeral: true
      });
    }
  },
  {
    module: 'moderation',
    name: 'clear',
    description: 'Bulk delete up to 100 messages (optionally only from one user)',
    requiredPermission: 'ManageChannels',
    configure(b: SlashCommandBuilder) {
      b.addIntegerOption((o) => o.setName('count').setDescription('Number of messages (1-100)').setMinValue(1).setMaxValue(100))
        .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'));
    },
    async run(ctx, interaction) {
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) throw new SupreError('MISSING_CHANNEL', 'must be a text channel');
      const textChannel = channel as GuildTextBasedChannel;
      const count = Math.min(Math.max(interaction.options.getInteger('count') ?? 10, 1), 100);
      const userOpt = interaction.options.getUser('user');
      const loc = await localeOf(ctx, interaction);

      const fetched = await textChannel.messages.fetch({ limit: 100 });
      let toDelete = [...fetched.values()];
      if (userOpt) toDelete = toDelete.filter((m) => m.author.id === userOpt.id);
      toDelete = toDelete.slice(0, count);
      toDelete = toDelete.filter((m) => Date.now() - m.createdTimestamp < MAX_BULK_DELETE_AGE_MS);

      if (toDelete.length === 0) {
        await interaction.reply({
          content: 'Nothing to delete (messages older than 14 days cannot be bulk-deleted, or none match).',
          ephemeral: true
        });
        return;
      }
      await textChannel.bulkDelete(toDelete).catch(() => undefined);
      await ctx.logs.log({
        kind: 'message_delete',
        guildId: interaction.guild!.id,
        actorId: interaction.user.id,
        data: {
          channel: `${'name' in channel ? channel.name : ''} (${channel.id})`,
          author: `${interaction.user.tag} (bulk)`,
          content: `${toDelete.length} messages bulk-deleted${userOpt ? ` from <@${userOpt.id}>` : ''}`
        }
      });
      await interaction.reply({ content: translate(loc, 'mod.cleared', { count: toDelete.length }), ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'slowmode',
    description: 'Set slow mode for a text channel',
    requiredPermission: 'ManageChannels',
    configure(b: SlashCommandBuilder) {
      b.addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('seconds').setDescription('Delay in seconds (0-21600)').setMinValue(0).setMaxValue(21600).setRequired(true));
    },
    async run(ctx, interaction) {
      const channel = interaction.options.getChannel('channel') as Channel | null;
      if (!channel || channel.type !== ChannelType.GuildText) throw new SupreError('MISSING_CHANNEL', 'must be a text channel');
      const seconds = interaction.options.getInteger('seconds', true) ?? 0;
      await channel.setRateLimitPerUser(seconds).catch((err) => {
        throw toApiError(err, 'slow mode update failed');
      });
      const loc = await localeOf(ctx, interaction);
      await interaction.reply({
        content: translate(loc, 'mod.slowmode_set', { channel: `<#${channel.id}>`, seconds }),
        ephemeral: true
      });
    }
  },
  {
    module: 'moderation',
    name: 'lock',
    description: 'Lock a channel (remove Send Messages for @everyone)',
    requiredPermission: 'ManageChannels',
    configure(b: SlashCommandBuilder) {
      b.addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText));
    },
    async run(ctx, interaction) {
      const channel = interaction.options.getChannel('channel') as Channel | null;
      if (!channel || channel.type !== ChannelType.GuildText) throw new SupreError('MISSING_CHANNEL', 'must be a text channel');
      const guild = interaction.guild!;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch((err) => {
        throw toApiError(err, 'lock failed');
      });
      const loc = await localeOf(ctx, interaction);
      await interaction.reply({ content: translate(loc, 'mod.channel_locked', { channel: `<#${channel.id}>` }), ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'unlock',
    description: 'Unlock a channel (restore Send Messages for @everyone)',
    requiredPermission: 'ManageChannels',
    configure(b: SlashCommandBuilder) {
      b.addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText));
    },
    async run(ctx, interaction) {
      const channel = interaction.options.getChannel('channel') as Channel | null;
      if (!channel || channel.type !== ChannelType.GuildText) throw new SupreError('MISSING_CHANNEL', 'must be a text channel');
      const guild = interaction.guild!;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch((err) => {
        throw toApiError(err, 'unlock failed');
      });
      const loc = await localeOf(ctx, interaction);
      await interaction.reply({ content: translate(loc, 'mod.channel_unlocked', { channel: `<#${channel.id}>` }), ephemeral: true });
    }
  },
  {
    module: 'moderation',
    name: 'case',
    description: 'Look up a moderation case by number',
    requiredPermission: 'ModerateMembers',
    configure(b: SlashCommandBuilder) {
      b.addIntegerOption((o) => o.setName('number').setDescription('Case number').setMinValue(1).setRequired(true));
    },
    async run(ctx, interaction) {
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const number = interaction.options.getInteger('number', true) ?? 0;
      const loc = await localeOf(ctx, interaction);
      const rows = await ctx.db.query<{
        case_number: number;
        type: string;
        target_id: string;
        moderator_id: string | null;
        reason: string;
        note: string | null;
        evidence: string | null;
        expires_at: Date | null;
        status: string;
        created_at: Date;
      }>(
        `SELECT case_number, type, target_id, moderator_id, reason, note, evidence, expires_at, status, created_at
         FROM moderation_cases WHERE guild_id = $1 AND case_number = $2
         ORDER BY created_at DESC LIMIT 1`,
        [guild.id, number]
      );
      const row = rows.rows[0];
      if (!row) {
        await interaction.reply({ content: translate(loc, 'mod.case_not_found', { case: number }), ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(`Case #${row.case_number} — ${row.type}`)
        .setColor(0x5865f2)
        .addFields(
          { name: 'Target', value: `<@${row.target_id}>`, inline: true },
          { name: 'Moderator', value: row.moderator_id ? `<@${row.moderator_id}>` : 'automated', inline: true },
          { name: 'Status', value: row.status, inline: true },
          { name: 'Reason', value: row.reason || '—' },
          { name: 'Note', value: row.note ?? '—', inline: true },
          {
            name: 'Expires',
            value: row.expires_at ? row.expires_at.toISOString() : '—',
            inline: true
          },
          { name: 'Created', value: row.created_at.toISOString(), inline: true }
        );
      if (row.evidence) embed.setImage(row.evidence);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
];
