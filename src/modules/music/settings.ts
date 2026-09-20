import { z } from 'zod';

/**
 * Music module settings.
 *
 * Queue state itself is in-memory (per guild, per process) — only playback
 * policy is persisted here. See docs/TROUBLESHOOTING.md ("Music") for the
 * consequences (queue does not survive restarts).
 */
export const musicSettingsSchema = z.object({
  /** Initial volume for new queues (0–150; >100 clips). */
  defaultVolume: z.number().int().min(0).max(150).default(80),
  /** Maximum number of tracks in the queue. */
  maxQueueLength: z.number().int().min(1).max(200).default(100),
  /** Reject non-live tracks longer than this (seconds; 0 = unlimited). */
  maxTrackSeconds: z.number().int().min(0).max(6 * 3600).default(0),
  /** Leave the voice channel this long after the queue ends (seconds). */
  idleTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
  /**
   * Channel for now-playing announcements. Null = the text channel that
   * ran `/music play`.
   */
  announceChannelId: z.string().nullable().default(null),
  /**
   * Role that may control the queue (skip/stop/volume/…). Null = anyone in
   * the same voice channel. ManageGuild always qualifies.
   */
  manageRoleId: z.string().nullable().default(null)
});

export type MusicSettings = z.infer<typeof musicSettingsSchema>;

export const musicSettingsDefaults: MusicSettings = {
  defaultVolume: 80,
  maxQueueLength: 100,
  maxTrackSeconds: 0,
  idleTimeoutSeconds: 300,
  announceChannelId: null,
  manageRoleId: null
};
