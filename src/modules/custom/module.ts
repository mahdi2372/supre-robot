import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { ModuleContext, SupreCommand, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';
import type { CustomCommandRow } from './executor.js';

export const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const PERMISSION_CHOICES = ['ManageRoles', 'ManageChannels', 'KickMembers', 'BanMembers', 'ModerateMembers'];
const RESERVED_NAMES = new Set(['custom', 'customlist', 'customdelete', 'customtoggle', 'customcreate']);

async function locale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Sync enabled custom commands for a guild to Discord's guild command API
 * (full-list replace, idempotent).
 */
export async function syncGuildCommands(ctx: ModuleContext, guildId: string): Promise<void> {
  const rows = await ctx.db.query<Pick<CustomCommandRow, 'name'>>(
    'SELECT name FROM custom_commands WHERE guild_id = $1 AND enabled = TRUE ORDER BY name',
    [guildId]
  );

  const body = rows.rows.map((r) => ({
    name: r.name,
    description: 'Custom command — vars: {{user}} {{user_name}} {{guild}} {{channel}} {{args}}',
    options: [
      {
        type: 3, // ApplicationCommandOptionType.STRING
        name: 'args',
        description: 'Arguments passed to the command',
        required: false,
        max_length: 200
      }
    ]
  }));

  const rest = new REST({ version: '10' }).setToken(ctx.config.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(ctx.config.DISCORD_CLIENT_ID, guildId), { body });
  ctx.logger.debug({ guildId, count: body.length }, 'custom: guild commands synced');
}

/**
 * /customcreate — top-level command to keep the option surface flat and
 * discoverable; template variables are documented on the command itself.
 */
const customCreateCommand: SupreCommand = {
  module: 'custom',
  name: 'customcreate',
  description: 'Create a custom command (safe template: {{user}} {{user_name}} {{guild}} {{channel}} {{args}})',
  requiredPermission: 'ManageGuild',
  configure(builder: SlashCommandBuilder) {
    builder
      .addStringOption((o) => o.setName('name').setDescription('Command name (lowercase, a-z 0-9 _ -)').setRequired(true).setMaxLength(32))
      .addStringOption((o) =>
        o.setName('response').setDescription('Response template. Vars: {{user}} {{user_name}} {{guild}} {{channel}} {{args}}').setRequired(true).setMaxLength(1900)
      )
      .addIntegerOption((o) => o.setName('cooldown').setDescription('Cooldown per user in seconds').setMinValue(0).setMaxValue(3600))
      .addRoleOption((o) => o.setName('role').setDescription('Only this role may use it'))
      .addStringOption((o) =>
        o.setName('permission').setDescription('Required Discord permission').addChoices(...PERMISSION_CHOICES.map((p) => ({ name: p, value: p })))
      );
  },
  async run(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
    const loc = await locale(ctx, guild.id);

    const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
    const response = interaction.options.getString('response', true) ?? '';
    if (!NAME_RE.test(name)) {
      throw new SupreError('INVALID_INPUT', 'name must be 1-32 chars of a-z, 0-9, _ or -');
    }
    if (RESERVED_NAMES.has(name)) {
      throw new SupreError('INVALID_INPUT', 'that name conflicts with a built-in command');
    }
    const cooldown = (interaction.options.getInteger('cooldown') ?? 0) * 1000;
    const role = interaction.options.getRole('role');
    const permission = interaction.options.getString('permission') ?? null;

    await ctx.settings.ensureGuild(guild.id, guild.name);
    await ctx.db.query(
      `INSERT INTO custom_commands (guild_id, name, response, required_role_id, required_permission, cooldown_ms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id, name) DO UPDATE SET
         response = EXCLUDED.response,
         required_role_id = EXCLUDED.required_role_id,
         required_permission = EXCLUDED.required_permission,
         cooldown_ms = EXCLUDED.cooldown_ms,
         enabled = TRUE`,
      [guild.id, name, response, role?.id ?? null, permission, cooldown, interaction.user.id]
    );

    await syncGuildCommands(ctx, guild.id);
    await ctx.logs.log({
      kind: 'config',
      guildId: guild.id,
      actorId: interaction.user.id,
      data: { module: 'custom', change: `created /${name}` }
    });
    await interaction.reply({ content: translate(loc, 'custom.created', { name }), ephemeral: true });
  }
};

/**
 * Custom commands module.
 *
 * Admins define guild-specific commands (stored in the DB) which are synced
 * to Discord as guild commands with a single optional `args` option.
 * Responses render through the safe template engine — variables only,
 * no code execution is possible.
 */
export const customModule: SupreModule = {
  name: 'custom',
  version: '0.1.0',
  description: 'Admin-defined guild commands with safe templating',
  dependencies: ['core', 'logging'],
  commands: [
    customCreateCommand,
    {
      module: 'custom',
      name: 'customlist',
      description: 'List this server’s custom commands',
      requiredPermission: 'ManageGuild',
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const loc = await locale(ctx, guild.id);
        const rows = await ctx.db.query<{ name: string; enabled: boolean; cooldown_ms: number }>(
          'SELECT name, enabled, cooldown_ms FROM custom_commands WHERE guild_id = $1 ORDER BY name',
          [guild.id]
        );
        if (rows.rows.length === 0) {
          await interaction.reply({ content: translate(loc, 'custom.list_empty'), ephemeral: true });
          return;
        }
        const list = rows.rows
          .map((r) => `${r.enabled ? '✅' : '⛔'} /${r.name}${r.cooldown_ms > 0 ? ` (cooldown ${Math.round(r.cooldown_ms / 1000)}s)` : ''}`)
          .join('\n');
        await interaction.reply({
          content: `📜 ${translate(loc, 'custom.list_title', { count: rows.rows.length })}\n${list}`,
          ephemeral: true
        });
      }
    },
    {
      module: 'custom',
      name: 'customdelete',
      description: 'Delete a custom command',
      requiredPermission: 'ManageGuild',
      configure(b: SlashCommandBuilder) {
        b.addStringOption((o) => o.setName('name').setDescription('Command name').setRequired(true));
      },
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        const res = await ctx.db.query('DELETE FROM custom_commands WHERE guild_id = $1 AND name = $2', [guild.id, name]);
        if ((res.rowCount ?? 0) === 0) {
          await interaction.reply({ content: translate(await locale(ctx, guild.id), 'custom.not_found', { name }), ephemeral: true });
          return;
        }
        await syncGuildCommands(ctx, guild.id);
        await ctx.logs.log({ kind: 'config', guildId: guild.id, actorId: interaction.user.id, data: { module: 'custom', change: `deleted /${name}` } });
        await interaction.reply({ content: translate(await locale(ctx, guild.id), 'custom.deleted', { name }), ephemeral: true });
      }
    },
    {
      module: 'custom',
      name: 'customtoggle',
      description: 'Enable or disable a custom command',
      requiredPermission: 'ManageGuild',
      configure(b: SlashCommandBuilder) {
        b.addStringOption((o) => o.setName('name').setDescription('Command name').setRequired(true))
          .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled state').setRequired(true));
      },
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        const enabled = interaction.options.getBoolean('enabled', true) ?? true;
        const res = await ctx.db.query('UPDATE custom_commands SET enabled = $3 WHERE guild_id = $1 AND name = $2', [
          guild.id,
          name,
          enabled
        ]);
        if ((res.rowCount ?? 0) === 0) {
          await interaction.reply({ content: translate(await locale(ctx, guild.id), 'custom.not_found', { name }), ephemeral: true });
          return;
        }
        await syncGuildCommands(ctx, guild.id);
        await ctx.logs.log({ kind: 'config', guildId: guild.id, actorId: interaction.user.id, data: { module: 'custom', change: `toggle /${name} -> ${enabled}` } });
        await interaction.reply({
          content: translate(await locale(ctx, guild.id), enabled ? 'custom.enabled' : 'custom.disabled', { name }),
          ephemeral: true
        });
      }
    }
  ],

  async startup(ctx: ModuleContext) {
    for (const guild of ctx.client.guilds.cache.values()) {
      await syncGuildCommands(ctx, guild.id).catch((err) => {
        ctx.logger.warn(
          { guildId: guild.id, err: { message: err instanceof Error ? err.message : String(err) } },
          'custom: boot sync failed'
        );
      });
    }
  }
};
