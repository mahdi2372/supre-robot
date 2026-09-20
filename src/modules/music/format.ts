/**
 * Pure formatting / policy helpers for the music module.
 * No Discord or discord-player imports — unit-testable in isolation.
 */

/** Clamp a volume to the allowed 0–150 range. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  const v = Math.round(volume);
  return Math.min(150, Math.max(0, v));
}

/**
 * Format a duration in milliseconds as `m:ss` or `h:mm:ss`.
 * `0` renders as `0:00`.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Parse a user duration input into whole seconds.
 * Accepts `90`, `1:30`, `1:02:03`. Returns null when unparseable.
 */
export function parseDurationSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!; // validated above: every part matches /^\d{1,3}$/
    const n = parseInt(part, 10);
    const isHours = parts.length === 3 && i === 0;
    if (!isHours && n > 59) return null; // minutes/seconds units cap at 59
    seconds = seconds * 60 + n;
  }
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export interface QueueTrackLine {
  title: string;
  author: string;
  /** Pre-formatted duration (`formatDurationMs`) or "LIVE". */
  duration: string;
}

/**
 * Render the queue as display lines. `current` is the now-playing track
 * (rendered first, prefixed), followed by up to `max` upcoming tracks.
 * Returns `[]` when there is nothing to show.
 */
export function buildQueueLines(
  current: QueueTrackLine | null,
  upcoming: QueueTrackLine[],
  max = 10
): string[] {
  const lines: string[] = [];
  if (current) {
    lines.push(`**Now playing** — ${current.title} · ${current.author} · ${current.duration}`);
  }
  const shown = upcoming.slice(0, max);
  shown.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title} · ${t.author} · ${t.duration}`);
  });
  if (upcoming.length > shown.length) {
    lines.push(`…and ${upcoming.length - shown.length} more`);
  }
  return lines;
}

export interface ManageCheck {
  isManageGuild: boolean;
  inSameVoiceChannel: boolean;
  hasManageRole: boolean;
  /** From settings; null = no role restriction. */
  manageRoleId: string | null;
}

/**
 * Decide whether a member may run a queue-control command.
 *  - ManageGuild always may;
 *  - no manageRoleId: must be in the same voice channel as the bot;
 *  - manageRoleId set: must hold that role (and be in the same channel).
 */
export function canManageMusic(opts: ManageCheck): boolean {
  if (opts.isManageGuild) return true;
  if (!opts.inSameVoiceChannel) return false;
  if (opts.manageRoleId === null) return true;
  return opts.hasManageRole;
}
