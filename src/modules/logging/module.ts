import {
  Events,
  type DMChannel,
  type GuildBan,
  GuildChannel,
  type GuildMember,
  type Message,
  type NonThreadGuildBasedChannel,
  type PartialGuildMember,
  type PartialMessage,
  type Role
} from 'discord.js';
import type { ModuleContext, SupreModule } from '../../core/module.js';
import { formatAccountAge } from '../../utils/format.js';
import { loggingSettingsDefaults, loggingSettingsSchema } from './settings.js';

/**
 * Audit-style logging module. Listens to Discord events and pipes them
 * through LogService (persist + optional channel delivery). All handlers are
 * best-effort: a logging failure must never break the event that triggered it.
 */
export const loggingModule: SupreModule = {
  name: 'logging',
  version: '0.1.0',
  description: 'Audit-style event logging to the database and configurable channels',

  startup(ctx: ModuleContext) {
    const guard = (fn: () => Promise<void>) => {
      fn().catch((err) => {
        ctx.logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'logging handler failed');
      });
    };

    ctx.client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
      guard(async () => {
        if (message.partial || !message.inGuild()) return;
        if (message.author?.bot) return;
        if (await ctx.settings.isEnabled(message.guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(message.guild.id, message.guild.name);
        const channelName =
          message.channel && 'name' in message.channel && message.channel.name ? message.channel.name : 'unknown';
        await ctx.logs.log({
          kind: 'message_delete',
          guildId: message.guild.id,
          actorId: message.author?.id,
          targetId: message.author?.id,
          data: {
            channel: `${channelName} (${message.channelId})`,
            author: message.author ? `${message.author.tag} (${message.author.id})` : 'unknown',
            content: message.content
          }
        });
      });
    });

    ctx.client.on(Events.MessageUpdate, (oldMsg: Message | PartialMessage, newMsg: Message | PartialMessage) => {
      guard(async () => {
        if (oldMsg.partial || newMsg.partial) return;
        if (!oldMsg.inGuild() || !newMsg.inGuild()) return;
        if (oldMsg.content === newMsg.content) return;
        if (oldMsg.author?.bot) return;
        if (await ctx.settings.isEnabled(oldMsg.guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(oldMsg.guild.id, oldMsg.guild.name);
        const channelName =
          newMsg.channel && 'name' in newMsg.channel && newMsg.channel.name ? newMsg.channel.name : 'unknown';
        await ctx.logs.log({
          kind: 'message_edit',
          guildId: oldMsg.guild.id,
          actorId: oldMsg.author?.id,
          data: {
            channel: `${channelName} (${newMsg.channelId})`,
            before: oldMsg.content,
            after: newMsg.content
          }
        });
      });
    });

    ctx.client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
      guard(async () => {
        const guild = member.guild;
        if (member.partial) {
          await ctx.settings.ensureGuild(guild.id, guild.name);
          await ctx.logs.log({
            kind: 'member_leave',
            guildId: guild.id,
            targetId: member.id,
            data: { user_name: member.id, user_id: member.id }
          });
          return;
        }
        if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(guild.id, guild.name);
        await ctx.logs.log({
          kind: 'member_leave',
          guildId: guild.id,
          targetId: member.id,
          data: { user_name: member.displayName, user_id: member.id }
        });
      });
    });

    ctx.client.on(Events.GuildMemberAdd, (member: GuildMember) => {
      guard(async () => {
        if (member.user.bot) return;
        if (await ctx.settings.isEnabled(member.guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(member.guild.id, member.guild.name);
        await ctx.logs.log({
          kind: 'member_join',
          guildId: member.guild.id,
          targetId: member.id,
          data: {
            user_name: member.displayName,
            user_id: member.id,
            account_age: formatAccountAge(member.user.createdAt)
          }
        });
      });
    });

    ctx.client.on(Events.GuildMemberUpdate, (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
      guard(async () => {
        if (oldMember.partial) return;
        const removed = oldMember.roles.cache
          .filter((r) => !newMember.roles.cache.has(r.id))
          .map((r) => r.name);
        const added = newMember.roles.cache
          .filter((r) => !oldMember.roles.cache.has(r.id))
          .map((r) => r.name);
        if (removed.length === 0 && added.length === 0) return;
        const guild = newMember.guild;
        if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(guild.id, guild.name);
        await ctx.logs.log({
          kind: 'role_change',
          guildId: guild.id,
          actorId: guild.members.me?.id,
          targetId: newMember.id,
          data: {
            user: newMember.displayName,
            added: added.join(', ') || '—',
            removed: removed.join(', ') || '—'
          }
        });
      });
    });

    const channelChange = (kind: 'created' | 'updated' | 'deleted') => {
      return (channel: DMChannel | NonThreadGuildBasedChannel) => {
        guard(async () => {
          if (!(channel instanceof GuildChannel)) return;
          const guild = channel.guild;
          if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
          await ctx.settings.ensureGuild(guild.id, guild.name);
          await ctx.logs.log({
            kind: 'channel_change',
            guildId: guild.id,
            data: {
              action: kind,
              channel: channel.name,
              type: channel.type
            }
          });
        });
      };
    };
    ctx.client.on(Events.ChannelCreate, (channel: DMChannel | NonThreadGuildBasedChannel) => channelChange('created')(channel));
    ctx.client.on(
      Events.ChannelUpdate,
      (oldChannel: DMChannel | NonThreadGuildBasedChannel, newChannel: DMChannel | NonThreadGuildBasedChannel) => {
        if (!(oldChannel instanceof GuildChannel) || !(newChannel instanceof GuildChannel)) return;
        guard(async () => {
          const changes: string[] = [];
        if (oldChannel.name !== newChannel.name) changes.push(`name: ${oldChannel.name} → ${newChannel.name}`);
        if (oldChannel.type !== newChannel.type) changes.push(`type changed`);
        if (oldChannel.parentId !== newChannel.parentId) changes.push(`moved to ${newChannel.parentId ?? 'no category'}`);
        if (changes.length === 0) return;
        const guild = newChannel.guild;
        if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(guild.id, guild.name);
        await ctx.logs.log({
          kind: 'channel_change',
          guildId: guild.id,
          data: { action: 'updated', channel: newChannel.name, changes: changes.join('\n') }
        });
      });
    });
    ctx.client.on(Events.ChannelDelete, (channel: DMChannel | NonThreadGuildBasedChannel) => channelChange('deleted')(channel));

    const roleChange = (kind: 'created' | 'updated' | 'deleted') => {
      return (role: Role) => {
        guard(async () => {
          const guild = role.guild;
          if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
          await ctx.settings.ensureGuild(guild.id, guild.name);
          await ctx.logs.log({
            kind: 'role_change',
            guildId: guild.id,
            data: { action: kind, role: role.name }
          });
        });
      };
    };
    ctx.client.on(Events.GuildRoleCreate, roleChange('created'));
    ctx.client.on(Events.GuildRoleDelete, roleChange('deleted'));

    ctx.client.on(Events.GuildBanAdd, (ban: GuildBan) => {
      guard(async () => {
        const guild = ban.guild;
        if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(guild.id, guild.name);
        await ctx.logs.log({
          kind: 'security',
          guildId: guild.id,
          targetId: ban.user.id,
          data: {
            action: 'ban_event',
            user: `${ban.user.tag ?? ban.user.id} (${ban.user.id})`,
            reason: ban.reason ?? null,
            severity: 'warning'
          }
        });
      });
    });

    ctx.client.on(Events.GuildBanRemove, (ban: GuildBan) => {
      guard(async () => {
        const guild = ban.guild;
        if (await ctx.settings.isEnabled(guild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(guild.id, guild.name);
        await ctx.logs.log({
          kind: 'security',
          guildId: guild.id,
          targetId: ban.user.id,
          data: {
            action: 'unban_event',
            user: `${ban.user.tag ?? ban.user.id} (${ban.user.id})`,
            severity: 'warning'
          }
        });
      });
    });

    ctx.client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
      guard(async () => {
        if (await ctx.settings.isEnabled(newGuild.id, 'logging') === false) return;
        await ctx.settings.ensureGuild(newGuild.id, newGuild.name);
        const changes: string[] = [];
        if (oldGuild.name !== newGuild.name) changes.push(`name: ${oldGuild.name} → ${newGuild.name}`);
        if (oldGuild.ownerId !== newGuild.ownerId) changes.push(`owner: ${oldGuild.ownerId} → ${newGuild.ownerId}`);
        if (oldGuild.verificationLevel !== newGuild.verificationLevel)
          changes.push(`verification level: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
        if (oldGuild.afkTimeout !== newGuild.afkTimeout) changes.push(`afk timeout changed`);
        if (changes.length === 0) return;
        await ctx.logs.log({
          kind: 'guild_change',
          guildId: newGuild.id,
          data: { changes: changes.join('\n') }
        });
      });
    });
  },

  shutdown(_ctx) {
    // Event listeners are owned by the client; client.destroy() removes them.
  }
};

export { loggingSettingsSchema, loggingSettingsDefaults };
