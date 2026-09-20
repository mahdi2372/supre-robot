import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { SupreModule } from '../../core/module.js';
import { SUPPORTED_LOCALES, translate } from '../../utils/i18n/index.js';
import { SupreError } from '../../utils/errors.js';
import { compactNumber } from '../../utils/format.js';
import { coreSettingsDefaults, coreSettingsSchema } from './settings.js';

export const BOT_VERSION = '0.1.0';

/**
 * Core module: always-on platform commands — ping, about, the admin
 * control-center status, and the guild language selector.
 */
export const coreModule: SupreModule = {
  name: 'core',
  version: BOT_VERSION,
  description: 'Platform core: ping, about, control center, language',
  commands: [
    {
      module: 'core',
      name: 'ping',
      description: 'Check bot and gateway latency',
      guildOnly: false,
      async run(ctx, interaction) {
        const gateway = ctx.client.ws.ping;
        const sent = Date.now();
        const reply = await interaction.reply({ content: '🏓 Pong...', fetchReply: true });
        const rtt = Date.now() - sent;
        await interaction.editReply(translate('en', 'core.ping', { gateway, rtt }));
        void reply;
      }
    },
    {
      module: 'core',
      name: 'about',
      description: 'About Supre Robot',
      guildOnly: false,
      async run(ctx, interaction) {
        const guild = interaction.guild;
        const embed = new EmbedBuilder()
          .setTitle('Supre Robot')
          .setDescription(
            [
              'A modular, production-grade Discord platform: moderation, auto-moderation, welcome, logging, custom commands, analytics and more.',
              '',
              'Every feature is an independently toggleable module. Configure it in the dashboard or with `/config`.'
            ].join('\n')
          )
          .setColor(0x5865f2)
          .addFields(
            { name: 'Version', value: BOT_VERSION, inline: true },
            { name: 'Uptime', value: `${Math.floor(process.uptime() / 60)}m`, inline: true }
          )
          .setFooter({
            text: guild ? `${guild.name} • ${compactNumber(guild.memberCount)} members` : 'Supre Robot'
          });
        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      module: 'core',
      name: 'lang',
      description: 'Set the default language for bot messages',
      configure(builder: SlashCommandBuilder) {
        builder.addSubcommand((sub) =>
          sub
            .setName('set')
            .setDescription('Set the guild language')
            .addStringOption((opt) =>
              opt
                .setName('locale')
                .setDescription('Language code')
                .setRequired(true)
                .addChoices(...SUPPORTED_LOCALES.map((l) => ({ name: l.toUpperCase(), value: l })))
            )
        );
      },
      requiredPermission: 'ManageGuild',
      async run(ctx, interaction) {
        if (!interaction.guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const locale = interaction.options.getString('locale', true) ?? 'en';
        if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
          throw new SupreError('INVALID_INPUT', `Unsupported locale ${locale}`);
        }
        await ctx.settings.set(
          interaction.guild.id,
          'core',
          { locale } as unknown as Record<string, unknown>,
          interaction.user.id
        );
        await ctx.logs.log({
          kind: 'config',
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          data: { module: 'core', change: `locale=${locale}` }
        });
        await interaction.reply({
          content: translate(locale, 'core.lang_set', { locale: locale.toUpperCase() }),
          ephemeral: true
        });
      }
    },
    {
      module: 'core',
      name: 'status',
      description: 'Admin control center: bot, database, modules, security and server stats',
      requiredPermission: 'ManageGuild',
      async run(ctx, interaction) {
        if (!interaction.guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const guild = interaction.guild;
        const locale = (await ctx.settings.get<{ locale?: string }>(guild.id, 'core')).locale ?? 'en';

        let dbOk = false;
        let dbMs: number | null = null;
        try {
          const t0 = Date.now();
          await ctx.db.query('SELECT 1');
          dbOk = true;
          dbMs = Date.now() - t0;
        } catch {
          dbOk = false;
        }

        const moduleSnap = ctx.moduleSnapshot();
        const readyCount = Object.values(moduleSnap).filter((m) => m.status === 'ready').length;

        let security24h = 0;
        let activeTickets = 0;
        let activeGiveaways = 0;
        try {
          const sec = await ctx.db.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM security_events WHERE guild_id = $1 AND created_at > now() - interval '24 hours'`,
            [guild.id]
          );
          security24h = sec.rows[0]?.n ?? 0;
          const tick = await ctx.db.query<{ n: number }>(
            'SELECT COUNT(*)::int AS n FROM tickets WHERE guild_id = $1 AND status = $2',
            [guild.id, 'open']
          );
          activeTickets = tick.rows[0]?.n ?? 0;
          const gw = await ctx.db.query<{ n: number }>(
            'SELECT COUNT(*)::int AS n FROM giveaways WHERE guild_id = $1 AND status = $2',
            [guild.id, 'active']
          );
          activeGiveaways = gw.rows[0]?.n ?? 0;
        } catch (err) {
          ctx.logger.warn({ err: { message: (err as Error).message } }, 'status: db stats unavailable');
        }

        const errors = ctx.metrics.snapshot();
        const commands = ctx.metrics.commandsSnapshot();
        const topCommands =
          Object.entries(commands.byName)
            .map(([name, n]) => `/${name}: ${n}`)
            .slice(0, 5)
            .join('\n') || '—';

        const embed = new EmbedBuilder()
          .setTitle(translate(locale, 'core.status_title', { guild: guild.name }))
          .setColor(dbOk ? 0x57f287 : 0xed4245)
          .addFields(
            {
              name: '🤖 Bot',
              value: `Uptime: ${Math.floor(process.uptime() / 60)}m\nGateway: ${ctx.client.ws.ping}ms\nGuilds: ${ctx.client.guilds.cache.size}`
            },
            { name: '🗄️ Database', value: dbOk ? `Connected (${dbMs}ms)` : '⚠️ Disconnected' },
            {
              name: '🧩 Modules',
              value: `${readyCount}/${Object.keys(moduleSnap).length} ready\n${Object.entries(moduleSnap)
                .map(([k, v]) => `${v.status === 'ready' ? '✅' : '❌'} ${k}`)
                .join('\n')}`
            },
            { name: '📈 Errors', value: `${errors.last30Min} in last 30m (rate ${errors.ratePerMinute}/min)` },
            { name: '⚡ Commands', value: `${commands.total} total\nTop: ${topCommands}` },
            { name: '🚨 Security (24h)', value: String(security24h) },
            {
              name: '📊 Server',
              value: `Members: ${compactNumber(guild.memberCount)}\nOpen tickets: ${activeTickets}\nActive giveaways: ${activeGiveaways}`
            }
          )
          .setTimestamp()
          .setFooter({ text: `Supre Robot v${BOT_VERSION}` });

        await interaction.reply({ embeds: [embed] });
      }
    }
  ]
};

export { coreSettingsSchema, coreSettingsDefaults };
