import { z } from 'zod';

export const coreSettingsSchema = z.object({
  /** Guild-wide UI language for bot messages. */
  locale: z.enum(['en', 'bn']).default('en'),
  /** Default cooldown (seconds) applied to all module commands. */
  commandCooldownSeconds: z.number().int().min(0).max(60).default(2)
});

export type CoreSettings = z.infer<typeof coreSettingsSchema>;

export const coreSettingsDefaults: CoreSettings = {
  locale: 'en',
  commandCooldownSeconds: 2
};
