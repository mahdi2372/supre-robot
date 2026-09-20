import { z } from 'zod';

/**
 * Template variables for welcome/leave messages (documented for admins):
 *  {{user}}        — mention of the member
 *  {{user_name}}   — display name
 *  {{guild}}       — server name
 *  {{count}}       — current member count
 *  {{account_age}} — human-readable account age
 */
export const welcomeSettingsSchema = z.object({
  channelId: z.string().nullable().default(null),
  joinTitle: z.string().max(256).default('Welcome to {{guild}}!'),
  joinDescription: z
    .string()
    .max(2000)
    .default('👋 Welcome **{{user}}** — you are our {{count}}th member (account age: {{account_age}}).'),
  leaveDescription: z
    .string()
    .max(2000)
    .default('👋 **{{user}}** left **{{guild}}**. Current members: {{count}}.'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#5865f2'),
  /** 'avatar' = member avatar, 'guild' = server icon, null = no image. */
  image: z.enum(['avatar', 'guild']).nullable().default('avatar'),
  dmEnabled: z.boolean().default(false),
  dmMessage: z.string().max(2000).default('Welcome to {{guild}}! We are glad you are here. 🎉'),
  autoRoleIds: z.array(z.string()).max(10).default([]),
  /** Auto-roles are only granted to accounts older than this (abuse protection). */
  minAccountAgeMinutes: z.number().int().min(0).default(10),
  /** Assign an unverified-style role before verification grants the real one (optional). */
  requireRulesAcknowledgement: z.boolean().default(false)
});

export type WelcomeSettings = z.infer<typeof welcomeSettingsSchema>;

export const welcomeSettingsDefaults: WelcomeSettings = {
  channelId: null,
  joinTitle: 'Welcome to {{guild}}!',
  joinDescription: '👋 Welcome **{{user}}** — you are our {{count}}th member (account age: {{account_age}}).',
  leaveDescription: '👋 **{{user}}** left **{{guild}}**. Current members: {{count}}.',
  color: '#5865f2',
  image: 'avatar',
  dmEnabled: false,
  dmMessage: 'Welcome to {{guild}}! We are glad you are here. 🎉',
  autoRoleIds: [],
  minAccountAgeMinutes: 10,
  requireRulesAcknowledgement: false
};
