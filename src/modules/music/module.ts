import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  VoiceChannel,
  type ChatInputCommandInteraction,
  type GuildMember
} from 'discord.js';
import type { Player } from 'discord-player';
import type { ModuleContext, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';
import { escapeDiscordMarkdown } from '../../utils/templating.js';
import type { MusicSettings } from './settings.js';
import {
  buildQueueLines,
  canManageMusic,
  formatDurationMs,
  parseDurationSeconds
} from './format.js';
import {
  bindMusicEvents,
  createPlayer,
  getQueue,
  isLiveTrack,
  leaveQueue,
  loadExtractors,
  pauseQueue,
  queueSize,
  removeTrackAt,
  resumeQueue,
  seekQueue,
  setLoopMode,
  setQueueVolume,
  getQueueVolume,
  skipQueue,
  startPlayback,
  stopQueue,
  toggleQueueShuffle,
  trackLine,
  type MusicQueueMeta,
  type PlayResult
} from './service.js';
import type { GuildQueue } from 'discord-player';

/**
 * Music module.
 *
 * discord-player owns the per-guild queue and voice connection (in-memory —
 * a restart drops queues). Members in a voice channel play/queue tracks;
 * queue control is gated by voice-channel membership and an optional
 * manage role. Now-playing embeds go to the configured announce channel or
 * the channel that started playback.
 */

/** Module-scoped player (created in startup, destroyed in shutdown). */
let player: Player | null = null;

export const musicModule: SupreModule = {
  name: 'music',
  version: '0.1.0',
  description: 'Music playback: play, queue, skip, loop, shuffle, volume',

  startup: async (ctx: ModuleContext) => {
    const p = createPlayer(ctx.client);
    await loadExtractors(p);
    bindMusicEvents(p, { client: ctx.client, settings: ctx.settings, logs: ctx.logs, logger: ctx.logger });
    player = p;
    ctx.logger.info({ extractors: p.extractors.size }, 'music module ready');
  },

  shutdown: async (_ctx: ModuleContext) => {
    await player?.destroy().catch(() => undefined);
    player = null;
  },

  commands: [
    {
      module: 'music',
      name: 'music',
      description: 'Play and control music in your voice channel',
      guildOnly: true,
      cooldownSeconds: 2,
      configure(builder: SlashCommandBuilder) {
        builder
          .addSubcommand((sub) =>
            sub
              .setName('play')
              .setDescription('Play a track or playlist (search or URL)')
              .addStringOption((o) =>
                o.setName('query').setDescription('Search query or track/playlist URL').setRequired(true).setMaxLength(500)
              )
          )
          .addSubcommand((sub) => sub.setName('queue').setDescription('Show the current queue'))
          .addSubcommand((sub) => sub.setName('now').setDescription('Show the current track'))
          .addSubcommand((sub) => sub.setName('skip').setDescription('Skip the current track'))
          .addSubcommand((sub) => sub.setName('stop').setDescription('Stop playback and clear the queue'))
          .addSubcommand((sub) => sub.setName('leave').setDescription('Leave the voice channel'))
          .addSubcommand((sub) => sub.setName('pause').setDescription('Pause playback'))
          .addSubcommand((sub) => sub.setName('resume').setDescription('Resume playback'))
          .addSubcommand((sub) =>
            sub
              .setName('loop')
              .setDescription('Set loop mode')
              .addStringOption((o) =>
                o
                  .setName('mode')
                  .setDescription('Loop mode')
                  .setRequired(true)
                  .addChoices(
                    { name: 'off', value: 'off' },
                    { name: 'track', value: 'track' },
                    { name: 'queue', value: 'queue' }
                  )
              )
          )
          .addSubcommand((sub) => sub.setName('shuffle').setDescription('Toggle shuffle'))
          .addSubcommand((sub) =>
            sub
              .setName('volume')
              .setDescription('Show or set the volume (0–150)')
              .addIntegerOption((o) => o.setName('percent').setDescription('Volume (0–150)').setMinValue(0).setMaxValue(150))
          )
          .addSubcommand((sub) =>
            sub
              .setName('remove')
              .setDescription('Remove a track from the queue by position')
              .addIntegerOption((o) =>
                o.setName('position').setDescription('1-based position in the queue').setRequired(true).setMinValue(1).setMaxValue(200)
              )
          )
          .addSubcommand((sub) =>
            sub
              .setName('seek')
              .setDescription('Seek the current track (e.g. 90, 1:30, 1:02:03)')
              .addStringOption((o) => o.setName('time').setDescription('Target position').setRequired(true).setMaxLength(16))
          );
      },
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const member = interaction.member as GuildMember;
        const p = requirePlayer();
        const s = await ctx.settings.get<MusicSettings>(guild.id, 'music');
        const loc = await guildLocale(ctx, guild.id);
        const sub = interaction.options.getSubcommand();

        switch (sub) {
          case 'play': {
            const query = interaction.options.getString('query') ?? '';
            if (!query.trim()) throw new SupreError('INVALID_INPUT', 'empty query');
            const vc = voiceChannelOf(member);
            if (!vc) {
              await interaction.reply({ content: translate(loc, 'music.not_in_voice'), ephemeral: true });
              return;
            }
            const existing = getQueue(p, guild.id);
            if (existing && queueSize(existing) >= s.maxQueueLength) {
              await interaction.reply({
                content: translate(loc, 'music.queue_full', { limit: String(s.maxQueueLength) }),
                ephemeral: true
              });
              return;
            }
            await interaction.deferReply();
            let res: PlayResult;
            try {
              res = await startPlayback({
                player: p,
                voiceChannel: vc,
                query,
                settings: s,
                channelId: interaction.channelId ?? null
              });
            } catch (err) {
              ctx.logger.warn(
                { guildId: guild.id, query: query.slice(0, 200), err: { message: err instanceof Error ? err.message : String(err) } },
                'music: play failed'
              );
              await interaction.editReply(translate(loc, 'music.play_failed')).catch(() => undefined);
              return;
            }
            await ctx.logs
              .log({
                kind: 'music',
                guildId: guild.id,
                actorId: member.id,
                data: { action: 'play', query: query.slice(0, 200), title: res.track.title.slice(0, 200), added: res.addedCount }
              })
              .catch(() => undefined);

            const line = trackLine(res.track);
            let msg: string;
            if (res.removed.some((t) => t.id === res.track.id)) {
              msg = translate(loc, 'music.track_too_long', {
                title: line.title,
                seconds: String(s.maxTrackSeconds)
              });
            } else if (res.playlist) {
              msg = translate(loc, 'music.playlist_queued', {
                title: escapeDiscordMarkdown(res.playlist.title).slice(0, 120),
                count: String(res.addedCount)
              });
            } else if (res.queue.currentTrack && res.queue.currentTrack.id === res.track.id) {
              msg = translate(loc, 'music.playing_now', { title: line.title, duration: line.duration });
            } else {
              msg = translate(loc, 'music.queued', { title: line.title, duration: line.duration });
            }
            await interaction.editReply(msg);
            return;
          }

          case 'queue': {
            const queue = getQueue(p, guild.id);
            if (!queue) {
              await interaction.reply({ content: translate(loc, 'music.not_playing'), ephemeral: true });
              return;
            }
            const current = queue.currentTrack;
            const lines = buildQueueLines(current ? trackLine(current) : null, queue.tracks.toArray().map(trackLine), 10);
            if (lines.length === 0) {
              await interaction.reply({ content: translate(loc, 'music.queue_empty'), ephemeral: true });
              return;
            }
            const total = queueSize(queue) + (current ? 1 : 0);
            await interaction.reply({
              content: `${translate(loc, 'music.queue_title', { count: String(total) })}\n${lines.join('\n')}`,
              ephemeral: true
            });
            return;
          }

          case 'now': {
            const queue = getQueue(p, guild.id);
            const current = queue?.currentTrack ?? null;
            if (!current) {
              await interaction.reply({ content: translate(loc, 'music.not_playing'), ephemeral: true });
              return;
            }
            const line = trackLine(current);
            const key = isLiveTrack(current) ? 'music.now_live' : 'music.now_playing';
            await interaction.reply(translate(loc, key, {
              title: line.title,
              duration: line.duration,
              author: line.author
            }));
            return;
          }

          case 'skip': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const title = queue.currentTrack ? trackLine(queue.currentTrack).title : '—';
            skipQueue(queue);
            await interaction.reply(translate(loc, 'music.skipped', { title }));
            return;
          }

          case 'stop': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            stopQueue(queue, s, ctx.logger);
            await ctx.logs
              .log({ kind: 'music', guildId: guild.id, actorId: member.id, data: { action: 'stop' } })
              .catch(() => undefined);
            await interaction.reply(translate(loc, 'music.stopped'));
            return;
          }

          case 'leave': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            leaveQueue(queue);
            await ctx.logs
              .log({ kind: 'music', guildId: guild.id, actorId: member.id, data: { action: 'leave' } })
              .catch(() => undefined);
            await interaction.reply(translate(loc, 'music.left'));
            return;
          }

          case 'pause': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            pauseQueue(queue);
            await interaction.reply(translate(loc, 'music.paused'));
            return;
          }

          case 'resume': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            resumeQueue(queue);
            await interaction.reply(translate(loc, 'music.resumed'));
            return;
          }

          case 'loop': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const mode = (interaction.options.getString('mode') ?? 'off') as 'off' | 'track' | 'queue';
            setLoopMode(queue, mode);
            await interaction.reply(translate(loc, 'music.loop', { mode }));
            return;
          }

          case 'shuffle': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const on = toggleQueueShuffle(queue);
            await interaction.reply(translate(loc, on ? 'music.shuffle_on' : 'music.shuffle_off'));
            return;
          }

          case 'volume': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const percent = interaction.options.getInteger('percent');
            if (percent === null) {
              await interaction.reply(translate(loc, 'music.volume_now', { volume: String(getQueueVolume(queue)) }));
              return;
            }
            const applied = setQueueVolume(queue, percent);
            await interaction.reply(translate(loc, 'music.volume_set', { volume: String(applied) }));
            return;
          }

          case 'remove': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const position = interaction.options.getInteger('position') ?? 1;
            const removed = removeTrackAt(queue, position - 1);
            if (!removed) {
              await interaction.reply({
                content: translate(loc, 'music.remove_invalid', { count: String(queueSize(queue)) }),
                ephemeral: true
              });
              return;
            }
            await interaction.reply(
              translate(loc, 'music.removed', { title: trackLine(removed).title, position: String(position) })
            );
            return;
          }

          case 'seek': {
            const queue = await requireControllable(p, guild, member, s);
            if (!queue) {
              await replyNotPlaying(ctx, guild.id, interaction);
              return;
            }
            const time = interaction.options.getString('time') ?? '';
            const seconds = parseDurationSeconds(time);
            if (seconds === null) throw new SupreError('INVALID_INPUT', 'invalid time');
            const ok = await seekQueue(queue, seconds);
            await interaction.reply(
              ok
                ? translate(loc, 'music.seeked', { time: formatDurationMs(seconds * 1000) })
                : translate(loc, 'music.seek_failed')
            );
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

function requirePlayer(): Player {
  if (!player) throw new SupreError('INTERNAL', 'music player not ready');
  return player;
}

function voiceChannelOf(member: GuildMember): VoiceChannel | null {
  const ch = member.voice.channel;
  return ch instanceof VoiceChannel ? ch : null;
}

/**
 * Fetch the queue for this guild and enforce the queue-control gate
 * (same voice channel + optional manage role / ManageGuild).
 * Returns null when nothing is playing (the caller replies music.not_playing).
 */
async function requireControllable(
  p: Player,
  guild: { id: string },
  member: GuildMember,
  s: MusicSettings
): Promise<GuildQueue<MusicQueueMeta> | null> {
  const queue = getQueue(p, guild.id);
  if (!queue) return null;
  const own = voiceChannelOf(member);
  const botChannel = queue.channel;
  const inSame = !!own && !!botChannel && own.id === botChannel.id;
  const allowed = canManageMusic({
    isManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    inSameVoiceChannel: inSame,
    hasManageRole: s.manageRoleId ? member.roles.cache.has(s.manageRoleId) : false,
    manageRoleId: s.manageRoleId
  });
  if (!allowed) throw new SupreError('PERMISSION_DENIED', 'queue control not allowed');
  return queue;
}

async function replyNotPlaying(ctx: ModuleContext, guildId: string, interaction: ChatInputCommandInteraction): Promise<void> {
  const loc = await guildLocale(ctx, guildId);
  await interaction.reply({ content: translate(loc, 'music.not_playing'), ephemeral: true });
}

async function guildLocale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}
