import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel
} from 'discord.js';
import type { ModuleContext } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { safeSideEffect } from '../../security/sanitize.js';
import { escapeDiscordMarkdown } from '../../utils/templating.js';
import { buildTranscriptChunks, type TranscriptMessage } from './transcript.js';
import type { TicketsSettings } from './settings.js';

export interface TicketRow {
  id: string;
  number: number;
  channel_id: string;
  requester_id: string;
  assigned_to: string | null;
  status: 'open' | 'closed';
  close_reason: string | null;
  closed_by: string | null;
  created_at: Date;
  closed_at: Date | null;
}

/** Thrown when the requester already has the maximum number of open tickets. */
export class TicketLimitError extends SupreError {
  constructor(public readonly max: number) {
    super('RATE_LIMITED', `open ticket limit (${max}) reached`);
    this.name = 'TicketLimitError';
  }
}

const MAX_SUBJECT = 120;
const MAX_CAPTURED_CONTENT = 2000;
const VIEW_SEND = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory
];

function rowToTicket(r: Record<string, unknown>): TicketRow {
  return {
    id: String(r.id ?? ''),
    number: Number(r.number ?? 0),
    channel_id: String(r.channel_id ?? ''),
    requester_id: String(r.requester_id ?? ''),
    assigned_to: r.assigned_to == null ? null : String(r.assigned_to),
    status: (r.status as 'open' | 'closed') ?? 'open',
    close_reason: r.close_reason == null ? null : String(r.close_reason),
    closed_by: r.closed_by == null ? null : String(r.closed_by),
    created_at: r.created_at as Date,
    closed_at: (r.closed_at as Date | null) ?? null
  };
}

// ---------- reads ----------

export async function countOpenTickets(ctx: ModuleContext, guildId: string, userId: string): Promise<number> {
  const res = await ctx.db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tickets WHERE guild_id = $1 AND requester_id = $2 AND status = 'open'`,
    [guildId, userId]
  );
  return res.rows[0]?.n ?? 0;
}

export async function getOpenTicketByChannel(
  ctx: ModuleContext,
  guildId: string,
  channelId: string
): Promise<TicketRow | null> {
  const res = await ctx.db.query<Record<string, unknown>>(
    `SELECT * FROM tickets WHERE guild_id = $1 AND channel_id = $2 AND status = 'open' LIMIT 1`,
    [guildId, channelId]
  );
  return res.rows[0] ? rowToTicket(res.rows[0]) : null;
}

export async function listOpenTickets(ctx: ModuleContext, guildId: string): Promise<TicketRow[]> {
  const res = await ctx.db.query<Record<string, unknown>>(
    `SELECT * FROM tickets WHERE guild_id = $1 AND status = 'open' ORDER BY created_at ASC LIMIT 100`,
    [guildId]
  );
  return res.rows.map(rowToTicket);
}

// ---------- permissions (pure, unit-testable) ----------

export function isTicketStaff(member: GuildMember, s: TicketsSettings): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  return s.staffRoleIds.some((id) => member.roles.cache.has(id));
}

export function canCloseTicket(opts: {
  closerId: string;
  requesterId: string;
  isStaff: boolean;
  requesterCanClose: boolean;
}): boolean {
  if (opts.isStaff) return true;
  return opts.requesterCanClose && opts.closerId === opts.requesterId;
}

// ---------- operations (single path) ----------

/**
 * Post the captured transcript of an open ticket as fenced code-block
 * messages. Returns the number of captured messages included (0 = nothing to
 * transcribe). Never throws — transcript failures must not block a close.
 */
export async function postTicketTranscript(
  ctx: ModuleContext,
  channel: TextChannel,
  ticket: TicketRow,
  s: TicketsSettings
): Promise<number> {
  const msgRes = await ctx.db.query<{ author_id: string | null; content: string | null; created_at: Date }>(
    `SELECT author_id, content, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT $2`,
    [ticket.id, s.transcriptLimit]
  );
  const msgs: TranscriptMessage[] = msgRes.rows
    .slice()
    .reverse()
    .map((m) => ({
      author: m.author_id ?? 'unknown',
      content: m.content ?? '',
      at: m.created_at
    }));
  if (msgs.length === 0) return 0;
  const chunks = buildTranscriptChunks(msgs, s.transcriptLimit);
  await safeSideEffect(async () => {
    for (const c of chunks) {
      // Guard the fence: user content can contain triple backticks.
      await channel.send(`\`\`\`\n${c.replace(/```/g, "'''")}\n\`\`\``);
    }
  }, (err) => {
    ctx.logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'ticket transcript failed');
  });
  return msgs.length;
}

export async function openTicket(
  ctx: ModuleContext,
  guild: Guild,
  requester: GuildMember,
  subject: string
): Promise<{ ticket: TicketRow; channel: TextChannel }> {
  const s = await ctx.settings.get<TicketsSettings>(guild.id, 'tickets');
  await ctx.settings.ensureGuild(guild.id, guild.name);

  const open = await countOpenTickets(ctx, guild.id, requester.id);
  if (open >= s.maxOpenPerUser) throw new TicketLimitError(s.maxOpenPerUser);

  // Atomic per-guild numbering (UPDATE ... RETURNING) — no gaps under
  // concurrency, no unique-violation retry loop.
  const numRes = await ctx.db.query<{ n: number }>(
    `UPDATE servers SET ticket_counter = ticket_counter + 1 WHERE guild_id = $1 RETURNING ticket_counter AS n`,
    [guild.id]
  );
  const number = numRes.rows[0]?.n;
  if (number == null) throw new SupreError('DB_ERROR', 'could not allocate a ticket number');

  const insRes = await ctx.db.query<{ id: string | number }>(
    `INSERT INTO tickets (guild_id, number, category, channel_id, requester_id, status)
     VALUES ($1, $2, 'general', '', $3, 'open')
     RETURNING id`,
    [guild.id, number, requester.id]
  );
  const ticketId = String(insRes.rows[0]?.id ?? '');

  const me = guild.members.me;
  if (!me) throw new SupreError('DISCORD_API', 'bot is not a member of this guild');

  const overwrites: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: requester.id, allow: VIEW_SEND },
    {
      id: me.id,
      allow: [...VIEW_SEND, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages]
    }
  ];
  for (const roleId of s.staffRoleIds) overwrites.push({ id: roleId, allow: VIEW_SEND });

  let channel: TextChannel;
  try {
    channel = (await guild.channels.create({
      name: `ticket-${number}`,
      type: ChannelType.GuildText,
      parent: s.categoryId ?? undefined,
      reason: `Ticket #${number} — ${requester.displayName}`,
      permissionOverwrites: overwrites
    })) as TextChannel;
  } catch (err) {
    // Compensate: drop the orphan row so the number is not burned.
    await ctx.db.query(`DELETE FROM tickets WHERE id = $1`, [ticketId]).catch(() => undefined);
    throw new SupreError('DISCORD_API', 'ticket channel creation failed', {
      message: err instanceof Error ? err.message : String(err)
    });
  }

  await ctx.db.query(`UPDATE tickets SET channel_id = $2 WHERE id = $1`, [ticketId, channel.id]);

  const ticket: TicketRow = {
    id: ticketId,
    number,
    channel_id: channel.id,
    requester_id: requester.id,
    assigned_to: null,
    status: 'open',
    close_reason: null,
    closed_by: null,
    created_at: new Date(),
    closed_at: null
  };

  const subjectLine = subject.trim().slice(0, MAX_SUBJECT);
  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🎫 Ticket #${number}`)
          .setDescription(
            subjectLine
              ? `**${escapeDiscordMarkdown(subjectLine)}**`
              : `Opened by ${requester}. Use \`/ticket close\` when done.`
          )
          .addFields(
            { name: 'Requester', value: `${requester}`, inline: true },
            { name: 'Opened', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
          )
          .setFooter({ text: `${guild.name} — ticket #${number}` })
      ]
    })
    .catch(() => undefined);

  if (s.channelId) {
    const annId = s.channelId;
    await safeSideEffect(async () => {
      const ann = guild.channels.cache.get(annId);
      if (ann && 'send' in ann) {
        await (ann as { send: (p: unknown) => Promise<unknown> }).send(
          `🎫 **Ticket #${number}** opened by ${requester} — <#${channel.id}>`
        );
      }
    }, (err) => {
      ctx.logger.warn(
        { err: { message: err instanceof Error ? err.message : String(err) } },
        'ticket announcement failed'
      );
    });
  }

  await ctx.logs
    .log({
      kind: 'ticket',
      guildId: guild.id,
      actorId: requester.id,
      targetId: requester.id,
      data: { action: 'opened', number, channel: channel.id, subject: subjectLine }
    })
    .catch(() => undefined);

  return { ticket, channel };
}

export async function closeTicket(
  ctx: ModuleContext,
  guild: Guild,
  channel: TextChannel,
  closer: GuildMember,
  reason: string,
  s: TicketsSettings,
  closeDelayMs: number
): Promise<TicketRow> {
  const ticket = await getOpenTicketByChannel(ctx, guild.id, channel.id);
  if (!ticket) throw new SupreError('MISSING_CHANNEL', 'no open ticket in this channel');

  const reasonLine = reason.trim().slice(0, 300);

  if (s.transcriptEnabled) {
    await postTicketTranscript(ctx, channel, ticket, s);
  }

  await ctx.db.query(
    `UPDATE tickets SET status = 'closed', closed_at = now(), close_reason = $2, closed_by = $3 WHERE id = $1`,
    [ticket.id, reasonLine, closer.id]
  );

  await channel
    .send(
      `🔒 **Ticket #${ticket.number}** closed by ${closer}.` +
        (reasonLine ? ` Reason: ${escapeDiscordMarkdown(reasonLine)}.` : '')
    )
    .catch(() => undefined);

  if (s.channelId) {
    const annId = s.channelId;
    await safeSideEffect(async () => {
      const ann = guild.channels.cache.get(annId);
      if (ann && 'send' in ann) {
        await (ann as { send: (p: unknown) => Promise<unknown> }).send(
          `🔒 **Ticket #${ticket.number}** closed by ${closer}.`
        );
      }
    }, () => undefined);
  }

  const t = setTimeout(() => {
    void channel.delete(`ticket #${ticket.number} closed`).catch((err) => {
      ctx.logger.warn(
        { err: { message: err instanceof Error ? err.message : String(err) } },
        'ticket channel delete failed'
      );
    });
  }, closeDelayMs);
  t.unref();

  await ctx.logs
    .log({
      kind: 'ticket',
      guildId: guild.id,
      actorId: closer.id,
      targetId: ticket.requester_id,
      data: { action: 'closed', number: ticket.number, channel: channel.id, reason: reasonLine }
    })
    .catch(() => undefined);

  return {
    ...ticket,
    status: 'closed',
    close_reason: reasonLine,
    closed_by: closer.id,
    closed_at: new Date()
  };
}

export async function claimTicket(
  ctx: ModuleContext,
  guildId: string,
  channelId: string,
  member: GuildMember
): Promise<TicketRow | null> {
  const ticket = await getOpenTicketByChannel(ctx, guildId, channelId);
  if (!ticket) return null;
  await ctx.db.query(`UPDATE tickets SET assigned_to = $2 WHERE id = $1`, [ticket.id, member.id]);
  return { ...ticket, assigned_to: member.id };
}

export async function addTicketMember(
  ctx: ModuleContext,
  guild: Guild,
  channel: TextChannel,
  member: GuildMember,
  actor: GuildMember
): Promise<void> {
  const ticket = await getOpenTicketByChannel(ctx, guild.id, channel.id);
  if (!ticket) throw new SupreError('MISSING_CHANNEL', 'no open ticket in this channel');
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  });
  await ctx.logs
    .log({
      kind: 'ticket',
      guildId: guild.id,
      actorId: actor.id,
      targetId: member.id,
      data: { action: 'member_added', number: ticket.number, channel: channel.id }
    })
    .catch(() => undefined);
}

export async function removeTicketMember(
  ctx: ModuleContext,
  guild: Guild,
  channel: TextChannel,
  member: GuildMember,
  actor: GuildMember
): Promise<void> {
  const ticket = await getOpenTicketByChannel(ctx, guild.id, channel.id);
  if (!ticket) throw new SupreError('MISSING_CHANNEL', 'no open ticket in this channel');
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: null
  });
  await ctx.logs
    .log({
      kind: 'ticket',
      guildId: guild.id,
      actorId: actor.id,
      targetId: member.id,
      data: { action: 'member_removed', number: ticket.number, channel: channel.id }
    })
    .catch(() => undefined);
}

// ---------- event capture (registered by the module) ----------

/** Persist a message that happens inside an open ticket channel. */
export async function captureTicketMessage(ctx: ModuleContext, message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild || message.author.bot) return;
  if (message.channel.type !== ChannelType.GuildText) return;
  // Cheap pre-filter (no DB): ticket channels are created as `ticket-<n>`.
  // Renaming one out of that pattern stops capture — the DB query below is
  // still the arbiter for channels that keep the name.
  if (!message.channel.name?.startsWith('ticket-')) return;
  if (!(await ctx.settings.isEnabled(guild.id, 'tickets'))) return;
  const res = await ctx.db.query<{ id: string | number }>(
    `SELECT id FROM tickets WHERE guild_id = $1 AND channel_id = $2 AND status = 'open' LIMIT 1`,
    [guild.id, message.channelId]
  );
  const row = res.rows[0];
  if (!row) return;
  await ctx.db
    .query(
      `INSERT INTO ticket_messages (ticket_id, author_id, content) VALUES ($1, $2, $3)`,
      [String(row.id), message.author.id, message.content ? message.content.slice(0, MAX_CAPTURED_CONTENT) : null]
    )
    .catch(() => undefined);
}

/**
 * Restart recovery: an open ticket whose channel no longer exists (deleted
 * out-of-band, e.g. while the bot was down) is marked closed.
 */
export async function reconcileMissingTicketChannels(ctx: ModuleContext): Promise<void> {
  const res = await ctx.db.query<{ id: string | number; guild_id: string; channel_id: string }>(
    `SELECT id, guild_id, channel_id FROM tickets WHERE status = 'open'`
  );
  for (const row of res.rows) {
    const guild = ctx.client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (!guild.channels.cache.has(row.channel_id)) {
      await ctx.db
        .query(
          `UPDATE tickets SET status = 'closed', closed_at = now(), close_reason = 'channel deleted' WHERE id = $1`,
          [String(row.id)]
        )
        .catch(() => undefined);
      ctx.logger.info({ ticket: String(row.id), guildId: row.guild_id }, 'ticket closed — channel missing after restart');
    }
  }
}

/** Mark a ticket closed when its channel is deleted (live, not only at boot). */
export async function handleTicketChannelDelete(ctx: ModuleContext, guildId: string, channelId: string): Promise<void> {
  const res = await ctx.db.query<{ id: string | number }>(
    `SELECT id FROM tickets WHERE guild_id = $1 AND channel_id = $2 AND status = 'open' LIMIT 1`,
    [guildId, channelId]
  );
  const row = res.rows[0];
  if (!row) return;
  await ctx.db
    .query(
      `UPDATE tickets SET status = 'closed', closed_at = now(), close_reason = 'channel deleted' WHERE id = $1`,
      [String(row.id)]
    )
    .catch(() => undefined);
}
