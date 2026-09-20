import { z } from 'zod';

/**
 * Tickets module settings.
 *
 * `channelId` is the announcement channel (set via /config channel
 * module:tickets); ticket channels themselves are created on demand inside
 * `categoryId`.
 */
export const ticketsSettingsSchema = z.object({
  /** Announcement channel for ticket open/close events. */
  channelId: z.string().nullable().default(null),
  /** Category in which ticket channels are created (null = no category). */
  categoryId: z.string().nullable().default(null),
  /** Roles granted access when a ticket opens (staff roles). */
  staffRoleIds: z.array(z.string()).max(5).default([]),
  /** Maximum tickets one user may have open at once. */
  maxOpenPerUser: z.number().int().min(1).max(5).default(1),
  /** Capture a message transcript when a ticket is closed. */
  transcriptEnabled: z.boolean().default(true),
  /** How many of the most recent messages the transcript includes. */
  transcriptLimit: z.number().int().min(25).max(250).default(100),
  /** The requester may close their own ticket (staff can always). */
  requesterCanClose: z.boolean().default(true),
  /** Seconds to wait between "closed" and deleting the channel. */
  closeDelaySeconds: z.number().int().min(0).max(300).default(5)
});

export type TicketsSettings = z.infer<typeof ticketsSettingsSchema>;

export const ticketsSettingsDefaults: TicketsSettings = {
  channelId: null,
  categoryId: null,
  staffRoleIds: [],
  maxOpenPerUser: 1,
  transcriptEnabled: true,
  transcriptLimit: 100,
  requesterCanClose: true,
  closeDelaySeconds: 5
};
