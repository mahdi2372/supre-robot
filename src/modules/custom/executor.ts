import type { ChatInputCommandInteraction } from 'discord.js';
import type { ModuleContext } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { renderTemplate } from '../../utils/templating.js';
import { memberHasPermission, memberHasRole } from '../../core/permissions.js';
import { PermissionFlagsBits } from 'discord.js';
import { translate } from '../../utils/i18n/index.js';

export interface CustomCommandRow {
  id: string;
  name: string;
  response: string;
  required_role_id: string | null;
  required_permission: string | null;
  channel_ids: string[];
  cooldown_ms: number;
  enabled: boolean;
}

/**
 * Executes a DB-backed custom command.
 *
 * Security notes:
 *  - the response is rendered through the safe template engine (no code
 *    execution possible — only {{var}} substitution);
 *  - role / permission / channel restrictions are enforced here, server-side,
 *    regardless of what the client sent;
 *  - per-guild command cooldowns use the shared cache (Redis or memory).
 */
export async function executeCustomCommand(
  ctx: ModuleContext,
  row: CustomCommandRow,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');

  if (!row.enabled) throw new SupreError('MODULE_DISABLED', `custom command /${row.name} is disabled`);

  // Channel restriction (empty list = everywhere)
  if (row.channel_ids.length > 0 && interaction.channelId && !row.channel_ids.includes(interaction.channelId)) {
    await interaction.reply({
      content: `/${row.name} is not available in this channel.`,
      ephemeral: true
    });
    return;
  }

  // Role restriction
  const member = (interaction.member ?? null) as import('discord.js').GuildMember | null;
  const roleCheck = memberHasRole(member, row.required_role_id);
  if (!roleCheck.ok) {
    await interaction.reply({
      content: translate(await guildLocale(ctx, guild.id), 'error.permission_denied'),
      ephemeral: true
    });
    return;
  }

  // Permission restriction
  if (row.required_permission) {
    const bits = (PermissionFlagsBits as Record<string, bigint>)[row.required_permission];
    if (bits === undefined) {
      throw new SupreError('INVALID_INPUT', `custom command has unknown permission ${row.required_permission}`);
    }
    const permCheck = memberHasPermission(member, guild, bits);
    if (!permCheck.ok) {
      await interaction.reply({
        content: translate(await guildLocale(ctx, guild.id), 'error.permission_denied'),
        ephemeral: true
      });
      return;
    }
  }

  // Cooldown
  if (row.cooldown_ms > 0) {
    const seconds = Math.ceil(row.cooldown_ms / 1000);
    const n = await ctx.cache.incr(`custom_cd:${guild.id}:${interaction.user.id}:${row.name}`, seconds + 1).catch(() => 1);
    if (n > 1) {
      const loc = await guildLocale(ctx, guild.id);
      await interaction.reply({
        content: translate(loc, 'custom.cooldown', { seconds }),
        ephemeral: true
      });
      return;
    }
  }

  const args = interaction.options.getString('args') ?? '';
  const rendered = renderTemplate(row.response, {
    user: `<@${interaction.user.id}>`,
    user_name: interaction.user.username,
    guild: guild.name,
    channel: `<#${interaction.channelId ?? ''}>`,
    args
  });

  await interaction.reply({ content: rendered.slice(0, 2000) });
  ctx.logger.debug({ customCommand: row.name, guildId: guild.id }, 'custom command executed');
}

async function guildLocale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}
