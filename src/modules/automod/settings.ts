import { z } from 'zod';

export const automodSettingsSchema = z.object({
  ignoreBots: z.boolean().default(true),
  ignoreRoleIds: z.array(z.string()).max(20).default([]),
  ignoreChannelIds: z.array(z.string()).max(50).default([]),

  flood: z
    .object({
      enabled: z.boolean().default(true),
      windowMs: z.number().int().min(1000).max(300_000).default(10_000),
      maxMessages: z.number().int().min(2).max(200).default(8)
    })
    .default({}),
  duplicate: z
    .object({
      enabled: z.boolean().default(true),
      windowMs: z.number().int().min(1000).max(300_000).default(60_000),
      maxDuplicates: z.number().int().min(2).max(50).default(3)
    })
    .default({}),
  mentions: z
    .object({
      enabled: z.boolean().default(true),
      threshold: z.number().int().min(2).max(20).default(5)
    })
    .default({}),
  caps: z
    .object({
      enabled: z.boolean().default(true),
      minLength: z.number().int().min(8).max(500).default(15),
      ratio: z.number().min(0.1).max(1).default(0.7)
    })
    .default({}),
  emoji: z
    .object({
      enabled: z.boolean().default(true),
      ratio: z.number().min(0.1).max(1).default(0.6)
    })
    .default({}),
  invite: z
    .object({
      enabled: z.boolean().default(true)
    })
    .default({}),
  suspiciousUrl: z
    .object({
      enabled: z.boolean().default(true),
      domains: z.array(z.string().min(1).max(100)).max(50).default([
        'bit.ly',
        'tinyurl.com',
        't.co',
        'goo.gl',
        'is.gd',
        'ow.ly',
        'buff.ly',
        'cutt.ly',
        's.id',
        'vn.vu'
      ])
    })
    .default({}),
  bannedWords: z
    .object({
      enabled: z.boolean().default(true),
      words: z.array(z.string().min(1).max(50)).max(200).default([])
    })
    .default({}),
  customRegex: z
    .object({
      enabled: z.boolean().default(false),
      patterns: z.array(z.string().min(1).max(200)).max(20).default([])
    })
    .default({}),
  newAccount: z
    .object({
      enabled: z.boolean().default(true),
      minAccountAgeMinutes: z.number().int().min(1).max(30 * 24 * 60).default(60)
    })
    .default({}),

  /**
   * Confidence >= deleteThreshold  -> delete the message
   * Confidence >= actionThreshold  -> apply `action` (warn|timeout|kick|ban)
   * Below both                     -> log only, never punish
   */
  deleteThreshold: z.number().min(0.1).max(1).default(0.55),
  actionThreshold: z.number().min(0.5).max(1).default(0.85),
  multiSignalBoost: z.number().min(0).max(0.5).default(0.15),
  action: z.enum(['warn', 'timeout', 'kick', 'ban']).default('warn'),
  actionCooldownMs: z.number().int().min(0).max(3_600_000).default(120_000)
});

export type AutoModSettings = z.infer<typeof automodSettingsSchema>;

export const automodSettingsDefaults: AutoModSettings = {
  ignoreBots: true,
  ignoreRoleIds: [],
  ignoreChannelIds: [],
  flood: { enabled: true, windowMs: 10_000, maxMessages: 8 },
  duplicate: { enabled: true, windowMs: 60_000, maxDuplicates: 3 },
  mentions: { enabled: true, threshold: 5 },
  caps: { enabled: true, minLength: 15, ratio: 0.7 },
  emoji: { enabled: true, ratio: 0.6 },
  invite: { enabled: true },
  suspiciousUrl: {
    enabled: true,
    domains: ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'cutt.ly', 's.id', 'vn.vu']
  },
  bannedWords: { enabled: true, words: [] },
  customRegex: { enabled: false, patterns: [] },
  newAccount: { enabled: true, minAccountAgeMinutes: 60 },
  deleteThreshold: 0.55,
  actionThreshold: 0.85,
  multiSignalBoost: 0.15,
  action: 'warn',
  actionCooldownMs: 120_000
};
