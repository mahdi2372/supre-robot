import {
  GuildQueueEvent,
  Player,
  QueueRepeatMode,
  TrackSkipReason,
  type GuildQueue,
  type Playlist,
  type Track
} from 'discord-player';
import { EmbedBuilder, TextChannel, type Client, type VoiceChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { SettingsService } from '../../core/settings.js';
import type { LogService } from '../../services/logService.js';
import { escapeDiscordMarkdown } from '../../utils/templating.js';
import { clampVolume, formatDurationMs, type QueueTrackLine } from './format.js';
import type { MusicSettings } from './settings.js';

/**
 * Music playback service — the single path for all queue operations.
 *
 * discord-player (6.6.x, rewritten line) owns the voice connection and the
 * in-memory per-guild queue. Queue state is NOT persisted: a restart drops
 * queues (documented). All discord-player calls are wrapped here so the
 * module layer stays thin and testable (pure logic lives in format.ts).
 */

export interface MusicQueueMeta {
  /** Text channel that started playback — fallback announce target. */
  channelId: string | null;
}

export interface MusicDeps {
  client: Client;
  settings: SettingsService;
  logs: LogService;
  logger: Logger;
}

/** Per-guild idle-leave timers (cancelled by new playback). */
const idleTimers = new Map<string, NodeJS.Timeout>();

// NOTE (type boundary): discord-player ships a CJS .d.ts that resolves
// discord.js under the "require" condition, while this ESM project resolves
// it under the "import" condition. That yields two distinct type identities
// for the same runtime classes, so values crossing into discord-player's API
// are cast at the boundary (safe: identical runtime classes).
export function createPlayer(client: Client): Player {
  return new Player(client as never);
}

export async function loadExtractors(player: Player): Promise<void> {
  // Registers the known sources (YouTube, SoundCloud, Spotify, …) from the
  // @discord-player/extractor peer package.
  const res = await player.extractors.loadDefault();
  if (!res.success) {
    throw new Error(`extractor load failed: ${res.error?.message ?? 'unknown'}`);
  }
}

export function getQueue(player: Player, guildId: string): GuildQueue<MusicQueueMeta> | null {
  return (player.nodes.get(guildId) as GuildQueue<MusicQueueMeta> | null) ?? null;
}

/** Live streams have no duration in this library version. */
export function isLiveTrack(track: Track): boolean {
  return track.durationMS === 0 && track.duration === '0:00';
}

export function trackLine(track: Track): QueueTrackLine {
  return {
    title: escapeDiscordMarkdown(track.title).slice(0, 200),
    author: escapeDiscordMarkdown(track.author).slice(0, 100),
    duration: isLiveTrack(track) ? 'LIVE' : formatDurationMs(track.durationMS)
  };
}

export interface PlayResult {
  queue: GuildQueue<MusicQueueMeta>;
  /** The track returned by the resolver — may have been removed by the length limit. */
  track: Track;
  /** Playlist that was resolved (null for a single track/search hit). */
  playlist: Playlist | null;
  /** Number of tracks resolved (1 for a single track). */
  addedCount: number;
  /** Tracks removed by the max-length policy (empty when no limit). */
  removed: Track[];
}

/**
 * Resolve `query` and play it in `voiceChannel`. All per-guild policy
 * (volume, queue cap, idle leave, length limit) is applied here.
 */
export async function startPlayback(opts: {
  player: Player;
  voiceChannel: VoiceChannel;
  query: string;
  settings: MusicSettings;
  channelId: string | null;
}): Promise<PlayResult> {
  const { player, voiceChannel, query, settings, channelId } = opts;
  clearIdleTimer(voiceChannel.guild.id);

  const res = await player.play<MusicQueueMeta>(voiceChannel as never, query, {
    nodeOptions: {
      volume: settings.defaultVolume,
      selfDeaf: true,
      maxSize: settings.maxQueueLength,
      leaveOnEnd: true,
      leaveOnEndCooldown: settings.idleTimeoutSeconds * 1000,
      leaveOnStop: false,
      metadata: { channelId }
    }
  });

  const removed = applyTrackLengthLimit(res.queue, settings.maxTrackSeconds);
  const addedCount = res.searchResult ? res.searchResult.tracks.length : 1;
  return {
    queue: res.queue,
    track: res.track,
    playlist: res.searchResult?.playlist ?? null,
    addedCount,
    removed
  };
}

/** Remove non-live tracks longer than `maxSeconds` (0 = unlimited). */
export function applyTrackLengthLimit(queue: GuildQueue<MusicQueueMeta>, maxSeconds: number): Track[] {
  if (maxSeconds <= 0) return [];
  const removed: Track[] = [];
  for (const track of queue.tracks.toArray()) {
    if (!isLiveTrack(track) && track.durationMS > maxSeconds * 1000) {
      queue.removeTrack(track);
      removed.push(track);
    }
  }
  return removed;
}

// ---------- controls (thin wrappers) ----------

export function pauseQueue(queue: GuildQueue<MusicQueueMeta>): boolean {
  return queue.node.pause();
}

export function resumeQueue(queue: GuildQueue<MusicQueueMeta>): boolean {
  return queue.node.resume();
}

export function skipQueue(queue: GuildQueue<MusicQueueMeta>): boolean {
  return queue.node.skip({ reason: TrackSkipReason.Manual, description: 'manual skip' });
}

/** Stop playback and clear the queue; schedule the idle leave. */
export function stopQueue(queue: GuildQueue<MusicQueueMeta>, settings: MusicSettings, logger: Logger): void {
  queue.node.stop(false);
  scheduleIdleLeave(queue, settings.idleTimeoutSeconds, logger);
}

/** Disconnect from the voice channel immediately (queue is dropped). */
export function leaveQueue(queue: GuildQueue<MusicQueueMeta>): void {
  clearIdleTimer(queue.guild.id);
  queue.node.stop(true);
}

export function setQueueVolume(queue: GuildQueue<MusicQueueMeta>, volume: number): number {
  queue.node.setVolume(clampVolume(volume));
  return queue.node.volume;
}

export function getQueueVolume(queue: GuildQueue<MusicQueueMeta>): number {
  return queue.node.volume;
}

export type LoopOption = 'off' | 'track' | 'queue';

const LOOP_MAP: Record<LoopOption, QueueRepeatMode> = {
  off: QueueRepeatMode.OFF,
  track: QueueRepeatMode.TRACK,
  queue: QueueRepeatMode.QUEUE
};

export function setLoopMode(queue: GuildQueue<MusicQueueMeta>, mode: LoopOption): QueueRepeatMode {
  queue.setRepeatMode(LOOP_MAP[mode]);
  return queue.repeatMode;
}

/** Toggle shuffle (immediate, in-place). Returns the new state. */
export function toggleQueueShuffle(queue: GuildQueue<MusicQueueMeta>): boolean {
  return queue.toggleShuffle(false);
}

export function removeTrackAt(queue: GuildQueue<MusicQueueMeta>, index: number): Track | null {
  const tracks = queue.tracks.toArray();
  const track = tracks[index];
  if (!track) return null;
  return queue.removeTrack(track);
}

export function queueSize(queue: GuildQueue<MusicQueueMeta>): number {
  return queue.tracks.size;
}

/** Seek to `seconds` in the current track. Live/seekable-only. */
export async function seekQueue(queue: GuildQueue<MusicQueueMeta>, seconds: number): Promise<boolean> {
  const current = queue.currentTrack;
  if (!current) return false;
  if (isLiveTrack(current)) return false;
  return queue.node.seek(seconds);
}

// ---------- idle leave ----------

export function scheduleIdleLeave(queue: GuildQueue<MusicQueueMeta>, seconds: number, logger: Logger): void {
  const guildId = queue.guild.id;
  clearIdleTimer(guildId);
  if (seconds <= 0) return;
  const t = setTimeout(() => {
    idleTimers.delete(guildId);
    const idle = queue.node.isIdle() || (queue.isEmpty() && !queue.currentTrack);
    if (idle) {
      queue.node.stop(true);
      logger.info({ guildId }, 'music: idle timeout — left voice channel');
    }
  }, seconds * 1000);
  t.unref();
  idleTimers.set(guildId, t);
}

export function clearIdleTimer(guildId: string): void {
  const t = idleTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(guildId);
  }
}

// ---------- events (registered by the module) ----------

export function bindMusicEvents(player: Player, deps: MusicDeps): void {
  player.events.on(GuildQueueEvent.PlayerStart, (queue, track) => {
    void announceNowPlaying(queue as GuildQueue<MusicQueueMeta>, track, deps);
  });

  player.events.on(GuildQueueEvent.PlayerError, (queue, error) => {
    deps.logger.warn(
      { guildId: queue.guild.id, message: error.message },
      'music: track playback error (queue continues)'
    );
  });

  player.events.on(GuildQueueEvent.EmptyChannel, (queue) => {
    // Everyone left the voice channel — the bot leaves with them.
    clearIdleTimer(queue.guild.id);
    deps.logger.info({ guildId: queue.guild.id }, 'music: voice channel empty — leaving');
    queue.node.stop(true);
  });
}

/**
 * Best-effort now-playing announcement. Target: the configured announce
 * channel, else the text channel that started playback. Never throws.
 */
async function announceNowPlaying(
  queue: GuildQueue<MusicQueueMeta>,
  track: Track,
  deps: MusicDeps
): Promise<void> {
  try {
    const s = await deps.settings.get<MusicSettings>(queue.guild.id, 'music');
    const channelId = s.announceChannelId ?? queue.metadata?.channelId ?? null;
    if (!channelId) return;
    // Resolved through the client (not queue.guild) so channel types stay
    // within this project's discord.js identity.
    const channel = deps.client.channels.cache.get(channelId);
    if (!(channel instanceof TextChannel)) return;

    const line = trackLine(track);
    const embed = new EmbedBuilder()
      .setColor(0x1fb6ff)
      .setAuthor({ name: 'Now playing' })
      .setDescription(`**[${line.title}](${track.url})**`)
      .addFields(
        { name: 'Artist', value: line.author, inline: true },
        { name: 'Length', value: line.duration, inline: true },
        { name: 'Requested by', value: track.requestedBy ? `<@${track.requestedBy.id}>` : '—', inline: true }
      );
    if (track.thumbnail && track.thumbnail.startsWith('http')) embed.setThumbnail(track.thumbnail);
    const next = queue.tracks.size;
    if (next > 0) embed.setFooter({ text: `Up next: ${next} track(s)` });
    await channel.send({ embeds: [embed] });
  } catch {
    // Announcements are best effort — never break playback.
  }
}
