import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';
import type { ModuleContext, SupreCommand, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';

/**
 * Central configuration module:
 *  - toggle any module on/off per server;
 *  - view a module's current validated settings;
 *  - point the log channels of logging / moderation / welcome.
 * The web dashboard uses the same settings service with the same validation.
 */

const MODULE_CHANNEL_KEYS: Record<string, { module: string; key: string }> = {
  logging: { module: 'logging', key: 'defaultChannelId' },
  welcome: { module: 'welcome', key: 'channelId' },
  moderation: { module: 'moderation', key: 'logChannelId' },
  tickets: { module: 'tickets', key: 'channelId' },
  music: { module: 'music', key: 'announceChannelId' }
};

type CmdInteraction = ChatInputCommandInteraction;

const configCommand: SupreCommand = {
  module: 'config',
  name: 'config',
  description: 'Configure Supre Robot modules and channels for this server',
  requiredPermission: 'ManageGuild',
  configure(builder: SlashCommandBuilder) {
    builder
      .addSubcommand((sub) =>
        sub
          .setName('module')
          .setDescription('Manage a module (list / view / enable / disable)')
          .addStringOption((opt) =>
            opt.setName('action').setDescription('Action').setRequired(true).addChoices(
              { name: 'list', value: 'list' },
              { name: 'view', value: 'view' },
              { name: 'enable', value: 'enable' },
              { name: 'disable', value: 'disable' }
            )
          )
          .addStringOption((opt) => opt.setName('module').setDescription('Module name'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set a module’s log channel')
          .addStringOption((opt) =>
            opt.setName('module').setDescription('Module').setRequired(true).addChoices(
              { name: 'logging', value: 'logging' },
              { name: 'welcome', value: 'welcome' },
              { name: 'moderation', value: 'moderation' },
              { name: 'tickets', value: 'tickets' },
              { name: 'music', value: 'music' }
            )
          )
          .addChannelOption((opt) => opt.setName('channel').setDescription('Text channel (omit to clear)'))
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List all modules and their status'))
  },
  async run(ctx, interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'module') await runModuleSub(ctx, interaction);
    else if (sub === 'channel') await runChannelSub(ctx, interaction);
    else if (sub === 'list') await runList(ctx, interaction);
    else throw new SupreError('INVALID_INPUT', 'unknown subcommand');
  }
};

async function runModuleSub(ctx: ModuleContext, interaction: CmdInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
  const loc = await locale(ctx, guild.id);
  const action = interaction.options.getString('action', true) ?? 'view';
  const module = (interaction.options.getString('module') ?? '').toLowerCase();

  if (action === 'list') {
    await runList(ctx, interaction);
    return;
  }
  if (!module) throw new SupreError('INVALID_INPUT', 'module name required');

  const spec = ctx.settings.getSchema(module);
  if (!spec) {
    await interaction.reply({
      content: translate(loc, 'config.unknown_module', { module, list: ctx.settings.knownModules().join(', ') }),
      ephemeral: true
    });
    return;
  }

  if (action === 'view') {
    const current = await ctx.settings.get<Record<string, unknown>>(guild.id, module);
    const enabled = await ctx.settings.isEnabled(guild.id, module);
    const fields = Object.entries(current)
      .slice(0, 24)
      .map(([k, v]) => ({
        name: k.slice(0, 100),
        value: (Array.isArray(v) ? v.join(', ') : JSON.stringify(v) ?? 'null').slice(0, 1000) || '—',
        inline: false
      }));
    const embed = new EmbedBuilder()
      .setTitle(`${enabled ? '✅' : '⛔'} ${module} — current settings`)
      .setColor(0x5865f2)
      .addFields(fields);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const enable = action === 'enable';
    if (module === 'core') {
      await interaction.reply({ content: 'The core module cannot be disabled.', ephemeral: true });
      return;
    }
    await ctx.settings.setEnabled(guild.id, module, enable, interaction.user.id);
    await ctx.logs.log({
      kind: 'config',
      guildId: guild.id,
      actorId: interaction.user.id,
      data: { module, change: enable ? 'enabled' : 'disabled' }
    });
    await interaction.reply({
      content: translate(loc, enable ? 'config.module_enabled' : 'config.module_disabled', { module }),
      ephemeral: true
    });
    return;
  }

  throw new SupreError('INVALID_INPUT', 'action must be list, view, enable, or disable');
}

async function runChannelSub(ctx: ModuleContext, interaction: CmdInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
  const loc = await locale(ctx, guild.id);
  const moduleName = (interaction.options.getString('module', true) ?? '').toLowerCase();
  const channel = interaction.options.getChannel('channel');

  const target = MODULE_CHANNEL_KEYS[moduleName];
  if (!target) throw new SupreError('INVALID_INPUT', `module must be one of: ${Object.keys(MODULE_CHANNEL_KEYS).join(', ')}`);
  if (channel && channel.type !== ChannelType.GuildText) throw new SupreError('MISSING_CHANNEL', 'must be a text channel');
  const channelId = channel?.id ?? null;

  await ctx.settings.set(guild.id, target.module, { [target.key]: channelId } as never, interaction.user.id);
  await ctx.logs.log({
    kind: 'config',
    guildId: guild.id,
    actorId: interaction.user.id,
    data: { module: target.module, change: `${target.key}=${channelId ?? 'none'}` }
  });
  await interaction.reply({
    content: translate(loc, channelId ? 'config.channel_set' : 'config.channel_cleared', {
      module: target.module,
      channel: channelId ? `<#${channelId}>` : '—'
    }),
    ephemeral: true
  });
}

async function runList(ctx: ModuleContext, interaction: CmdInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
  const loc = await locale(ctx, guild.id);
  const snap = ctx.moduleSnapshot();
  const lines: string[] = [];
  for (const [name, info] of Object.entries(snap)) {
    const enabled = name === 'core' || (await ctx.settings.isEnabled(guild.id, name));
    const boot = info.status === 'ready' ? '✅' : '❌';
    const on = enabled ? 'on' : 'off';
    lines.push(`${boot} ${name} — **${on}** (v${info.version})`);
  }
  await interaction.reply({
    content: `🧩 ${translate(loc, 'config.module_list_title')}\n${lines.join('\n')}\n\nToggle: \`/config module <action> <module>\``,
    ephemeral: true
  });
}

export const configModule: SupreModule = {
  name: 'config',
  version: '0.1.0',
  description: 'Central module/channel configuration',
  dependencies: ['core'],
  commands: [configCommand]
};

async function locale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}
