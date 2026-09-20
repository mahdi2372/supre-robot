import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  GuildChannel,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type DMChannel,
  type GuildMember,
  type Interaction,
  type Message,
  type NonThreadGuildBasedChannel,
  type TextChannel
} from 'discord.js';
import type { ModuleContext, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';
import {
  TicketLimitError,
  addTicketMember,
  canCloseTicket,
  captureTicketMessage,
  claimTicket,
  closeTicket,
  getOpenTicketByChannel,
  handleTicketChannelDelete,
  isTicketStaff,
  listOpenTickets,
  openTicket,
  postTicketTranscript,
  reconcileMissingTicketChannels,
  removeTicketMember
} from './service.js';
import { type TicketsSettings } from './settings.js';

/**
 * Tickets module.
 *
 * Members open a private support channel (via /ticket open or the panel
 * button). Staff manage it with /ticket close|claim|add|remove|transcript|list.
 * Messages inside open tickets are captured for transcripts; tickets are
 * reconciled after restarts if their channel disappears.
 */
export const ticketsModule: SupreModule = {
  name: 'tickets',
  version: '0.1.0',
  description: 'Support tickets: private channels, transcripts, staff claims',

  register(ctx: ModuleContext) {
    ctx.ui.onButton('tickets:open', async (ctx2, interaction: Interaction) => {
      if (!interaction.isButton()) return;
      const guild = interaction.guild;
      if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
      const member = interaction.member as GuildMember;
      const loc = await guildLocale(ctx2, guild.id);
      await interaction.deferReply({ ephemeral: true });
      try {
        const { ticket } = await openTicket(ctx2, guild, member, '');
        await interaction.editReply(translate(loc, 'ticket.open_reply', { number: String(ticket.number) }));
      } catch (err) {
        if (err instanceof TicketLimitError) {
          await interaction.editReply(translate(loc, 'ticket.too_many', { max: String(err.max) }));
          return;
        }
        throw err;
      }
    });
  },

  startup(ctx: ModuleContext) {
    ctx.client.on(Events.MessageCreate, (message: Message) => {
      if (!message.inGuild()) return;
      void captureTicketMessage(ctx, message).catch(() => undefined);
    });

    ctx.client.on(Events.ChannelDelete, (channel: DMChannel | NonThreadGuildBasedChannel) => {
      if (!(channel instanceof GuildChannel)) return;
      if (channel.type !== ChannelType.GuildText) return;
      void handleTicketChannelDelete(ctx, channel.guild.id, channel.id).catch(() => undefined);
    });

    // Restart recovery, once the guild/channel caches are populated.
    ctx.client.once(Events.ClientReady, () => {
      void reconcileMissingTicketChannels(ctx).catch((err) => {
        ctx.logger.warn(
          { err: { message: err instanceof Error ? err.message : String(err) } },
          'ticket reconciliation failed'
        );
      });
    });
  },

  commands: [
    {
      module: 'tickets',
      name: 'ticket',
      description: 'Open and manage support tickets',
      guildOnly: true,
      configure(builder: SlashCommandBuilder) {
        builder
          .addSubcommand((sub) =>
            sub
              .setName('open')
              .setDescription('Open a ticket')
              .addStringOption((o) => o.setName('subject').setDescription('Short subject line').setMaxLength(120))
          )
          .addSubcommand((sub) =>
            sub
              .setName('close')
              .setDescription('Close this ticket')
              .addStringOption((o) => o.setName('reason').setDescription('Why is it being closed?').setMaxLength(300))
          )
          .addSubcommand((sub) => sub.setName('claim').setDescription('Claim this ticket for yourself'))
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Add a member to this ticket')
              .addUserOption((o) => o.setName('user').setDescription('Member to add').setRequired(true))
          )
          .addSubcommand((sub) =>
            sub
              .setName('remove')
              .setDescription('Remove a member from this ticket')
              .addUserOption((o) => o.setName('user').setDescription('Member to remove').setRequired(true))
          )
          .addSubcommand((sub) => sub.setName('list').setDescription('List open tickets'))
          .addSubcommand((sub) => sub.setName('transcript').setDescription('Post a transcript of this ticket'))
          .addSubcommand((sub) => sub.setName('panel').setDescription('Post the ticket panel button in this channel'));
      },
      cooldownSeconds: 3,
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const member = interaction.member as GuildMember;
        const s = await ctx.settings.get<TicketsSettings>(guild.id, 'tickets');
        const loc = await guildLocale(ctx, guild.id);
        const sub = interaction.options.getSubcommand();

        switch (sub) {
          case 'open': {
            await interaction.deferReply();
            try {
              const { ticket } = await openTicket(ctx, guild, member, interaction.options.getString('subject') ?? '');
              await interaction.editReply(translate(loc, 'ticket.open_reply', { number: String(ticket.number) }));
            } catch (err) {
              if (err instanceof TicketLimitError) {
                await interaction.editReply(translate(loc, 'ticket.too_many', { max: String(err.max) }));
                return;
              }
              throw err;
            }
            return;
          }

          case 'close': {
            const channel = ticketChannelOf(interaction);
            const ticket = await getOpenTicketByChannel(ctx, guild.id, channel.id);
            if (!ticket) {
              await interaction.reply({ content: translate(loc, 'ticket.not_a_ticket'), ephemeral: true });
              return;
            }
            if (
              !canCloseTicket({
                closerId: member.id,
                requesterId: ticket.requester_id,
                isStaff: isTicketStaff(member, s),
                requesterCanClose: s.requesterCanClose
              })
            ) {
              await interaction.reply({ content: translate(loc, 'ticket.close_denied'), ephemeral: true });
              return;
            }
            await interaction.deferReply();
            const closed = await closeTicket(
              ctx,
              guild,
              channel,
              member,
              interaction.options.getString('reason') ?? '',
              s,
              s.closeDelaySeconds * 1000
            );
            await interaction.editReply(
              translate(loc, 'ticket.closed', { number: String(closed.number), reason: closed.close_reason || '—' })
            );
            return;
          }

          case 'claim': {
            const channel = ticketChannelOf(interaction);
            if (!isTicketStaff(member, s)) throw new SupreError('PERMISSION_DENIED', 'staff only');
            const claimed = await claimTicket(ctx, guild.id, channel.id, member);
            if (!claimed) {
              await interaction.reply({ content: translate(loc, 'ticket.not_a_ticket'), ephemeral: true });
              return;
            }
            await interaction.reply(translate(loc, 'ticket.claimed', { user: `${member}` }));
            return;
          }

          case 'add': {
            const channel = ticketChannelOf(interaction);
            if (!isTicketStaff(member, s)) throw new SupreError('PERMISSION_DENIED', 'staff only');
            const target = await requireUser(guild, interaction.options.getUser('user'));
            await addTicketMember(ctx, guild, channel, target, member);
            await interaction.reply(translate(loc, 'ticket.member_added', { user: `${target}` }));
            return;
          }

          case 'remove': {
            const channel = ticketChannelOf(interaction);
            if (!isTicketStaff(member, s)) throw new SupreError('PERMISSION_DENIED', 'staff only');
            const target = await requireUser(guild, interaction.options.getUser('user'));
            await removeTicketMember(ctx, guild, channel, target, member);
            await interaction.reply(translate(loc, 'ticket.member_removed', { user: `${target}` }));
            return;
          }

          case 'list': {
            if (!isTicketStaff(member, s)) throw new SupreError('PERMISSION_DENIED', 'staff only');
            const rows = await listOpenTickets(ctx, guild.id);
            if (rows.length === 0) {
              await interaction.reply({ content: translate(loc, 'ticket.list_empty'), ephemeral: true });
              return;
            }
            const lines = rows
              .slice(0, 25)
              .map((t) => `**#${t.number}** <@${t.requester_id}>${t.assigned_to ? ` → <@${t.assigned_to}>` : ''} — <#${t.channel_id}>`)
              .join('\n');
            await interaction.reply({
              content: `${translate(loc, 'ticket.list_title', { count: String(rows.length) })}\n${lines}`,
              ephemeral: true
            });
            return;
          }

          case 'transcript': {
            const channel = ticketChannelOf(interaction);
            if (!isTicketStaff(member, s)) throw new SupreError('PERMISSION_DENIED', 'staff only');
            const ticket = await getOpenTicketByChannel(ctx, guild.id, channel.id);
            if (!ticket) {
              await interaction.reply({ content: translate(loc, 'ticket.not_a_ticket'), ephemeral: true });
              return;
            }
            const count = await postTicketTranscript(ctx, channel, ticket, s);
            if (count === 0) {
              await interaction.reply({ content: translate(loc, 'ticket.transcript_empty'), ephemeral: true });
              return;
            }
            await interaction.reply(translate(loc, 'ticket.transcript_sent', { count: String(count) }));
            return;
          }

          case 'panel': {
            if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
              throw new SupreError('PERMISSION_DENIED', 'ManageGuild required');
            }
            await interaction.reply({
              content: translate(loc, 'ticket.panel_desc'),
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId('tickets:open')
                    .setLabel(translate(loc, 'ticket.panel_button'))
                    .setEmoji('📩')
                    .setStyle(ButtonStyle.Primary)
                ).toJSON()
              ]
            });
            return;
          }

          default:
            throw new SupreError('INVALID_INPUT', 'unknown subcommand');
        }
      }
    }
  ]
};

// ---------- helpers ----------

function ticketChannelOf(interaction: ChatInputCommandInteraction): TextChannel {
  const ch = interaction.channel;
  if (!ch || !(ch instanceof GuildChannel) || ch.type !== ChannelType.GuildText) {
    throw new SupreError('MISSING_CHANNEL', 'must be used inside the ticket text channel');
  }
  return ch as TextChannel;
}

async function requireUser(
  guild: { members: { fetch: (id: string) => Promise<unknown> } },
  user: { id: string } | null
): Promise<GuildMember> {
  if (!user) throw new SupreError('INVALID_INPUT', 'missing user');
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) throw new SupreError('NOT_IN_GUILD', 'target is not a member');
  return member as GuildMember;
}

async function guildLocale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}
