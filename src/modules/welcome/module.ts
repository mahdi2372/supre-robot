import { Events, EmbedBuilder, SlashCommandBuilder, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { ModuleContext, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { renderTemplate } from '../../utils/templating.js';
import { formatAccountAge } from '../../utils/format.js';
import { safeSideEffect } from '../../security/sanitize.js';
import {
  welcomeSettingsDefaults,
  welcomeSettingsSchema,
  type WelcomeSettings
} from './settings.js';

function buildJoinEmbed(s: WelcomeSettings, member: GuildMember): EmbedBuilder {
  const vars = {
    user: `<@${member.id}>`,
    user_name: member.displayName,
    guild: member.guild.name,
    count: member.guild.memberCount,
    account_age: formatAccountAge(member.user.createdAt)
  };
  const embed = new EmbedBuilder()
    .setTitle(renderTemplate(s.joinTitle, vars))
    .setDescription(renderTemplate(s.joinDescription, vars))
    .setColor(parseInt(s.color.slice(1), 16))
    .setFooter({ text: `${member.guild.name} • ${member.guild.memberCount} members` })
    .setTimestamp();
  if (s.image === 'avatar') embed.setThumbnail(member.user.displayAvatarURL());
  else if (s.image === 'guild') embed.setThumbnail(member.guild.iconURL());
  return embed;
}

function buildLeaveEmbed(s: WelcomeSettings, member: GuildMember): EmbedBuilder {
  const vars = {
    user: `**${member.displayName}**`,
    user_name: member.displayName,
    guild: member.guild.name,
    count: member.guild.memberCount
  };
  return new EmbedBuilder()
    .setDescription(renderTemplate(s.leaveDescription, vars))
    .setColor(0xed4245)
    .setFooter({ text: member.guild.name })
    .setTimestamp();
}

async function assignAutoRoles(ctx: ModuleContext, member: GuildMember, s: WelcomeSettings): Promise<void> {
  if (s.autoRoleIds.length === 0) return;
  const ageOk =
    s.minAccountAgeMinutes <= 0 ||
    Date.now() - member.user.createdAt.getTime() >= s.minAccountAgeMinutes * 60_000;
  if (!ageOk) {
    ctx.logger.debug({ memberId: member.id }, 'welcome: account too new for auto-roles');
    return;
  }
  for (const roleId of s.autoRoleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role) continue;
    // Hierarchy guard: never grant a role at or above the bot's highest.
    const me = member.guild.members.me;
    if (me && role.position >= me.roles.highest.position) {
      ctx.logger.warn({ roleId }, 'welcome: auto-role above bot hierarchy — skipped');
      continue;
    }
    try {
      await member.roles.add(role, 'welcome auto-role');
    } catch (err) {
      ctx.logger.warn({ roleId, err: { message: err instanceof Error ? err.message : String(err) } }, 'welcome: auto-role grant failed');
    }
  }
}

export const welcomeModule: SupreModule = {
  name: 'welcome',
  version: '0.1.0',
  description: 'Welcome/leave messages, templates, auto-roles, DM welcome',

  startup(ctx: ModuleContext) {
    ctx.client.on(Events.GuildMemberAdd, (member: GuildMember) => {
      if (member.user.bot) return;
      safeSideEffect(async () => {
        if (!(await ctx.settings.isEnabled(member.guild.id, 'welcome'))) return;
        const s = await ctx.settings.get<WelcomeSettings>(member.guild.id, 'welcome');
        await ctx.settings.ensureGuild(member.guild.id, member.guild.name);

        if (s.channelId) {
          const channel = member.guild.channels.cache.get(s.channelId);
          if (channel && channel.isSendable()) {
            await channel.send({ embeds: [buildJoinEmbed(s, member)] });
          }
        }
        await assignAutoRoles(ctx, member, s);
        if (s.dmEnabled) {
          await member.send(renderTemplate(s.dmMessage, { guild: member.guild.name, user: member.displayName })).catch(() => undefined);
        }
      }, (err) => {
        ctx.logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'welcome join failed');
      });
    });

    ctx.client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
      safeSideEffect(async () => {
        if (member.partial) return;
        if (!(await ctx.settings.isEnabled(member.guild.id, 'welcome'))) return;
        const s = await ctx.settings.get<WelcomeSettings>(member.guild.id, 'welcome');
        if (!s.channelId) return;
        const channel = member.guild.channels.cache.get(s.channelId);
        if (channel && channel.isSendable()) {
          await channel.send({ embeds: [buildLeaveEmbed(s, member)] });
        }
      }, (err) => {
        ctx.logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'welcome leave failed');
      });
    });
  },

  commands: [
    {
      module: 'welcome',
      name: 'welcome',
      description: 'Configure the welcome/leave system',
      requiredPermission: 'ManageGuild',
      configure(builder: SlashCommandBuilder) {
        builder
          .addChannelOption((o) => o.setName('channel').setDescription('Channel for welcome/leave messages').addChannelTypes(0))
          .addStringOption((o) => o.setName('title').setDescription('Join embed title (vars: {{guild}} {{user}} {{count}})').setMaxLength(256))
          .addStringOption((o) =>
            o.setName('message').setDescription('Join description (vars: {{user}} {{guild}} {{count}} {{account_age}} {{user_name}})').setMaxLength(2000)
          );
      },
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const channel = interaction.options.getChannel('channel');
        const title = interaction.options.getString('title');
        const message = interaction.options.getString('message');
        if (!channel && !title && !message) {
          throw new SupreError('INVALID_INPUT', 'provide a channel, title, and/or message');
        }
        const patch: Record<string, unknown> = {};
        if (channel) patch.channelId = channel.id;
        if (title) patch.joinTitle = title;
        if (message) patch.joinDescription = message;
        await ctx.settings.set(guild.id, 'welcome', patch, interaction.user.id);
        await ctx.logs.log({
          kind: 'config',
          guildId: guild.id,
          actorId: interaction.user.id,
          data: { module: 'welcome', change: Object.keys(patch).join(', ') }
        });
        const embed = buildJoinEmbed(await ctx.settings.get<WelcomeSettings>(guild.id, 'welcome'), guild.members.me!);
        await interaction.reply({ content: '✅ Welcome settings updated. Live preview:', embeds: [embed], ephemeral: true });
      }
    },
    {
      module: 'welcome',
      name: 'preview',
      description: 'Preview the welcome message as it would appear',
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const s = await ctx.settings.get<WelcomeSettings>(guild.id, 'welcome');
        const embed = buildJoinEmbed(s, guild.members.me!);
        await interaction.reply({ content: 'Live preview (rendered for the bot account):', embeds: [embed], ephemeral: true });
      }
    }
  ]
};

export { welcomeSettingsSchema, welcomeSettingsDefaults };
