import { z } from 'zod';

export const escalationStepSchema = z
  .object({
    /** Total active warnings that trigger this step. */
    warnings: z.number().int().min(1).max(1000),
    action: z.enum(['timeout', 'kick', 'ban']),
    /** Timeout duration in minutes (required when action=timeout). */
    durationMinutes: z.number().int().min(1).max(28 * 24 * 60).optional()
  })
  .refine((s) => s.action !== 'timeout' || (s.durationMinutes ?? 0) > 0, {
    message: 'durationMinutes is required for timeout escalation steps'
  });

export const moderationSettingsSchema = z.object({
  /** Channel where moderation actions are announced. */
  logChannelId: z.string().nullable().default(null),
  /** How far back (days) to count warnings for escalation. */
  warnWindowDays: z.number().int().min(1).max(365).default(30),
  /**
   * Escalation ladder. When a user's warning count in the window reaches
   * `warnings` exactly, the step fires once.
   */
  escalation: z.array(escalationStepSchema).default([
    { warnings: 2, action: 'timeout', durationMinutes: 60 },
    { warnings: 5, action: 'kick' },
    { warnings: 10, action: 'ban' }
  ]),
  /** Default timeout duration in minutes for /timeout without an explicit one. */
  defaultTimeoutMinutes: z.number().int().min(1).max(28 * 24 * 60).default(60)
});

export type ModerationSettings = z.infer<typeof moderationSettingsSchema>;

export const moderationSettingsDefaults: ModerationSettings = {
  logChannelId: null,
  warnWindowDays: 30,
  escalation: [
    { warnings: 2, action: 'timeout', durationMinutes: 60 },
    { warnings: 5, action: 'kick' },
    { warnings: 10, action: 'ban' }
  ],
  defaultTimeoutMinutes: 60
};
