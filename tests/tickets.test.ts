import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import { buildTranscriptChunks, type TranscriptMessage } from '../src/modules/tickets/transcript.js';
import { canCloseTicket, isTicketStaff } from '../src/modules/tickets/service.js';
import { ticketsSettingsDefaults, ticketsSettingsSchema } from '../src/modules/tickets/settings.js';

describe('transcript chunking', () => {
  const at = new Date('2026-09-20T12:00:00Z');

  it('returns no chunks for no messages', () => {
    expect(buildTranscriptChunks([], 100)).toEqual([]);
  });

  it('formats a single message as a timestamped line', () => {
    const chunks = buildTranscriptChunks([{ author: 'Alice', content: 'hello', at }], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('[2026-09-20 12:00:00Z] Alice: hello');
  });

  it('marks empty content as an attachment/other placeholder', () => {
    const chunks = buildTranscriptChunks([{ author: 'Bob', content: '', at }], 100);
    expect(chunks[0]).toContain('Bob: *(attachment/other)*');
  });

  it('keeps only the most recent `limit` messages', () => {
    const msgs: TranscriptMessage[] = ['a', 'b', 'c'].map((author) => ({ author, content: 'x', at }));
    const chunks = buildTranscriptChunks(msgs, 2);
    expect(chunks[0]).not.toContain('[a]');
    expect(chunks[0]).toContain('b: x');
    expect(chunks[0]).toContain('c: x');
  });

  it('keeps every chunk within the Discord-safe budget and loses no content', () => {
    const msgs: TranscriptMessage[] = Array.from({ length: 400 }, (_, i) => ({
      author: `user${i}`,
      content: 'lorem ipsum dolor sit amet '.repeat(3),
      at
    }));
    const chunks = buildTranscriptChunks(msgs, 250);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
    // Reassembling the chunks must reproduce every kept line exactly (order intact).
    const reassembled = chunks.join('\n').split('\n');
    const expected = msgs.slice(msgs.length - 250).map((m) => `[2026-09-20 12:00:00Z] ${m.author}: ${m.content}`);
    expect(reassembled).toEqual(expected);
  });

  it('hard-splits a single over-long line without exceeding the budget', () => {
    const chunks = buildTranscriptChunks([{ author: 'big', content: 'x'.repeat(5000), at }], 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });
});

describe('close permissions (pure)', () => {
  const base = { closerId: 'u1', requesterId: 'u2' };

  it('staff can always close', () => {
    expect(canCloseTicket({ ...base, isStaff: true, requesterCanClose: false })).toBe(true);
  });

  it('the requester can close their own ticket when allowed', () => {
    expect(canCloseTicket({ ...base, closerId: 'u2', isStaff: false, requesterCanClose: true })).toBe(true);
  });

  it('the requester cannot close when the setting disables it', () => {
    expect(canCloseTicket({ ...base, closerId: 'u2', isStaff: false, requesterCanClose: false })).toBe(false);
  });

  it('other members cannot close', () => {
    expect(canCloseTicket({ ...base, isStaff: false, requesterCanClose: true })).toBe(false);
  });
});

describe('staff detection (pure)', () => {
  function fakeMember(opts: { manageChannels?: boolean; roles?: string[] }): GuildMember {
    return {
      permissions: {
        has: (p: bigint) => (opts.manageChannels ? p === PermissionFlagsBits.ManageChannels : false)
      },
      roles: { cache: { has: (id: string) => opts.roles?.includes(id) ?? false } }
    } as unknown as GuildMember;
  }

  const settings = (staffRoleIds: string[]) => ({ ...ticketsSettingsDefaults, staffRoleIds });

  it('ManageChannels counts as staff', () => {
    expect(isTicketStaff(fakeMember({ manageChannels: true }), settings([]))).toBe(true);
  });

  it('a configured staff role counts as staff', () => {
    expect(isTicketStaff(fakeMember({ roles: ['r1', 'r2'] }), settings(['r1']))).toBe(true);
  });

  it('a member with neither is not staff', () => {
    expect(isTicketStaff(fakeMember({ roles: ['r9'] }), settings(['r1']))).toBe(false);
  });
});

describe('tickets settings schema', () => {
  it('parses empty input to the documented defaults', () => {
    expect(ticketsSettingsSchema.parse({})).toEqual(ticketsSettingsDefaults);
  });

  it('bounds maxOpenPerUser to 1..5', () => {
    expect(ticketsSettingsSchema.parse({ maxOpenPerUser: 1 }).maxOpenPerUser).toBe(1);
    expect(ticketsSettingsSchema.parse({ maxOpenPerUser: 5 }).maxOpenPerUser).toBe(5);
    expect(() => ticketsSettingsSchema.parse({ maxOpenPerUser: 0 })).toThrow();
    expect(() => ticketsSettingsSchema.parse({ maxOpenPerUser: 6 })).toThrow();
  });

  it('bounds transcriptLimit to 25..250', () => {
    expect(ticketsSettingsSchema.parse({ transcriptLimit: 25 }).transcriptLimit).toBe(25);
    expect(ticketsSettingsSchema.parse({ transcriptLimit: 250 }).transcriptLimit).toBe(250);
    expect(() => ticketsSettingsSchema.parse({ transcriptLimit: 24 })).toThrow();
    expect(() => ticketsSettingsSchema.parse({ transcriptLimit: 251 })).toThrow();
  });

  it('bounds closeDelaySeconds to 0..300', () => {
    expect(ticketsSettingsSchema.parse({ closeDelaySeconds: 0 }).closeDelaySeconds).toBe(0);
    expect(ticketsSettingsSchema.parse({ closeDelaySeconds: 300 }).closeDelaySeconds).toBe(300);
    expect(() => ticketsSettingsSchema.parse({ closeDelaySeconds: -1 })).toThrow();
    expect(() => ticketsSettingsSchema.parse({ closeDelaySeconds: 301 })).toThrow();
  });

  it('caps staffRoleIds at 5 and requires null/empty channelId', () => {
    expect(ticketsSettingsSchema.parse({ staffRoleIds: ['a', 'b'] }).staffRoleIds).toEqual(['a', 'b']);
    expect(() =>
      ticketsSettingsSchema.parse({ staffRoleIds: ['a', 'b', 'c', 'd', 'e', 'f'] })
    ).toThrow();
    expect(ticketsSettingsSchema.parse({ channelId: null }).channelId).toBeNull();
    expect(ticketsSettingsSchema.parse({ channelId: '123' }).channelId).toBe('123');
  });
});
