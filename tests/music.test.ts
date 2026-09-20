import { describe, expect, it } from 'vitest';
import { Track } from 'discord-player';
import {
  buildQueueLines,
  canManageMusic,
  clampVolume,
  formatDurationMs,
  parseDurationSeconds,
  type QueueTrackLine
} from '../src/modules/music/format.js';
import { musicSettingsDefaults, musicSettingsSchema } from '../src/modules/music/settings.js';
import { isLiveTrack, trackLine } from '../src/modules/music/service.js';
import en from '../src/locales/en.js';
import bn from '../src/locales/bn.js';

function makeTrack(over: { title?: string; author?: string; duration?: string; url?: string } = {}): Track {
  return new Track({} as never, {
    title: over.title ?? 'Song',
    author: over.author ?? 'Artist',
    url: over.url ?? 'https://youtu.be/abc',
    duration: over.duration ?? '3:30'
  });
}

describe('clampVolume', () => {
  it('keeps values inside 0–150', () => {
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(80)).toBe(80);
    expect(clampVolume(150)).toBe(150);
  });

  it('clamps out-of-range values', () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(200)).toBe(150);
  });

  it('rounds and rejects non-finite input', () => {
    expect(clampVolume(80.4)).toBe(80);
    expect(clampVolume(NaN)).toBe(0);
    expect(clampVolume(Infinity)).toBe(0); // non-finite → mute, not max
  });
});

describe('formatDurationMs', () => {
  it('formats m:ss', () => {
    expect(formatDurationMs(0)).toBe('0:00');
    expect(formatDurationMs(90_000)).toBe('1:30');
    expect(formatDurationMs(61_000)).toBe('1:01');
  });

  it('formats h:mm:ss for long durations', () => {
    expect(formatDurationMs(3_661_000)).toBe('1:01:01');
    expect(formatDurationMs(3_600_000)).toBe('1:00:00');
  });

  it('renders invalid input as 0:00', () => {
    expect(formatDurationMs(-10)).toBe('0:00');
    expect(formatDurationMs(NaN)).toBe('0:00');
  });
});

describe('parseDurationSeconds', () => {
  it('accepts plain seconds (with surrounding spaces)', () => {
    expect(parseDurationSeconds('90')).toBe(90);
    expect(parseDurationSeconds('0')).toBe(0);
    expect(parseDurationSeconds('  45  ')).toBe(45);
  });

  it('accepts m:ss and h:mm:ss', () => {
    expect(parseDurationSeconds('1:30')).toBe(90);
    expect(parseDurationSeconds('1:02:03')).toBe(3723);
  });

  it('rejects malformed input', () => {
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('abc')).toBeNull();
    expect(parseDurationSeconds('1:60')).toBeNull(); // units cap at 59
    expect(parseDurationSeconds('1:2:3:4')).toBeNull();
    expect(parseDurationSeconds('1:')).toBeNull();
    expect(parseDurationSeconds('-5')).toBeNull();
  });
});

describe('buildQueueLines', () => {
  const line = (n: number): QueueTrackLine => ({ title: `t${n}`, author: 'a', duration: '1:00' });

  it('returns no lines when the queue is empty', () => {
    expect(buildQueueLines(null, [])).toEqual([]);
  });

  it('renders the now-playing track first', () => {
    const lines = buildQueueLines({ title: 'now', author: 'a', duration: '2:00' }, []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('**Now playing** — now');
  });

  it('numbers upcoming tracks from 1', () => {
    const lines = buildQueueLines(null, [line(1), line(2), line(3)]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('1. t1 · a · 1:00');
    expect(lines[2]).toBe('3. t3 · a · 1:00');
  });

  it('caps the display and announces the remainder', () => {
    const upcoming = Array.from({ length: 12 }, (_, i) => line(i + 1));
    const lines = buildQueueLines(null, upcoming, 10);
    expect(lines).toHaveLength(11); // 10 numbered + 1 "and N more"
    expect(lines[9]).toBe('10. t10 · a · 1:00');
    expect(lines[10]).toBe('…and 2 more');
  });
});

describe('canManageMusic', () => {
  it('always allows ManageGuild', () => {
    expect(
      canManageMusic({ isManageGuild: true, inSameVoiceChannel: false, hasManageRole: false, manageRoleId: 'r1' })
    ).toBe(true);
  });

  it('requires the same voice channel when no manage role is set', () => {
    const base = { hasManageRole: false, manageRoleId: null };
    expect(canManageMusic({ ...base, isManageGuild: false, inSameVoiceChannel: true })).toBe(true);
    expect(canManageMusic({ ...base, isManageGuild: false, inSameVoiceChannel: false })).toBe(false);
  });

  it('requires the manage role when one is set (and same channel)', () => {
    const base = { isManageGuild: false, manageRoleId: 'r1' };
    expect(canManageMusic({ ...base, inSameVoiceChannel: true, hasManageRole: true })).toBe(true);
    expect(canManageMusic({ ...base, inSameVoiceChannel: true, hasManageRole: false })).toBe(false);
    expect(canManageMusic({ ...base, inSameVoiceChannel: false, hasManageRole: true })).toBe(false);
  });
});

describe('music settings schema', () => {
  it('parses to the documented defaults', () => {
    expect(musicSettingsSchema.parse({})).toEqual(musicSettingsDefaults);
    expect(musicSettingsDefaults).toEqual({
      defaultVolume: 80,
      maxQueueLength: 100,
      maxTrackSeconds: 0,
      idleTimeoutSeconds: 300,
      announceChannelId: null,
      manageRoleId: null
    });
  });

  it('bounds the numeric policy values', () => {
    expect(musicSettingsSchema.parse({ defaultVolume: 0 }).defaultVolume).toBe(0);
    expect(musicSettingsSchema.parse({ defaultVolume: 150 }).defaultVolume).toBe(150);
    expect(musicSettingsSchema.safeParse({ defaultVolume: 151 }).success).toBe(false);
    expect(musicSettingsSchema.safeParse({ defaultVolume: -1 }).success).toBe(false);

    expect(musicSettingsSchema.parse({ maxQueueLength: 1 }).maxQueueLength).toBe(1);
    expect(musicSettingsSchema.safeParse({ maxQueueLength: 0 }).success).toBe(false);
    expect(musicSettingsSchema.safeParse({ maxQueueLength: 201 }).success).toBe(false);

    expect(musicSettingsSchema.parse({ maxTrackSeconds: 21600 }).maxTrackSeconds).toBe(21600);
    expect(musicSettingsSchema.safeParse({ maxTrackSeconds: -1 }).success).toBe(false);

    expect(musicSettingsSchema.parse({ idleTimeoutSeconds: 10 }).idleTimeoutSeconds).toBe(10);
    expect(musicSettingsSchema.safeParse({ idleTimeoutSeconds: 9 }).success).toBe(false);
    expect(musicSettingsSchema.safeParse({ idleTimeoutSeconds: 3601 }).success).toBe(false);
  });

  it('accepts nullable channel/role ids', () => {
    expect(musicSettingsSchema.parse({ announceChannelId: 'abc' }).announceChannelId).toBe('abc');
    expect(musicSettingsSchema.parse({ announceChannelId: null, manageRoleId: null }).manageRoleId).toBeNull();
  });
});

describe('track display helpers', () => {
  it('flags zero-duration tracks as live', () => {
    const live = makeTrack({ duration: '0:00' });
    const normal = makeTrack({ duration: '3:30' });
    expect(isLiveTrack(live)).toBe(true);
    expect(isLiveTrack(normal)).toBe(false);
  });

  it('renders live tracks with a LIVE badge', () => {
    expect(trackLine(makeTrack({ duration: '0:00' })).duration).toBe('LIVE');
    expect(trackLine(makeTrack({ duration: '3:30' })).duration).toBe('3:30');
  });

  it('does not leak raw markdown into display lines', () => {
    const line = trackLine(makeTrack({ title: 'a**b**`c`' }));
    expect(line.title).not.toContain('**');
    expect(line.title).not.toContain('`c`');
  });
});

describe('music i18n', () => {
  const placeholders = (s: string): string => (s.match(/\{\w+\}/g) ?? []).sort().join(',');

  const REQUIRED_KEYS = [
    'music.not_in_voice',
    'music.not_playing',
    'music.queue_full',
    'music.play_failed',
    'music.playing_now',
    'music.queued',
    'music.playlist_queued',
    'music.track_too_long',
    'music.queue_title',
    'music.queue_empty',
    'music.now_playing',
    'music.now_live',
    'music.skipped',
    'music.stopped',
    'music.left',
    'music.paused',
    'music.resumed',
    'music.loop',
    'music.shuffle_on',
    'music.shuffle_off',
    'music.volume_set',
    'music.volume_now',
    'music.removed',
    'music.remove_invalid',
    'music.seeked',
    'music.seek_failed'
  ];

  it('defines every key the module uses, in both locales', () => {
    for (const key of REQUIRED_KEYS) {
      expect(en[key], `en missing ${key}`).toBeDefined();
      expect(bn[key], `bn missing ${key}`).toBeDefined();
    }
  });

  it('mirrors every english music key with matching placeholders in bangla', () => {
    const musicKeys = Object.keys(en).filter((k) => k.startsWith('music.'));
    expect(musicKeys.length).toBeGreaterThanOrEqual(20);
    for (const key of musicKeys) {
      const enText = en[key];
      const bnText = bn[key];
      expect(bnText, `bn missing ${key}`).toBeDefined();
      expect(placeholders(bnText as string), `placeholder mismatch on ${key}`).toBe(placeholders(enText as string));
    }
  });
});
