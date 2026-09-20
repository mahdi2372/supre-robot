import { z } from 'zod';
import { LOG_KINDS } from '../../services/logService.js';

const channelMap = z
  .record(z.enum(LOG_KINDS).default(LOG_KINDS[0]!), z.string().nullable())
  .default({});

export const loggingSettingsSchema = z.object({
  /** Fallback channel for any kind that has no dedicated channel. */
  defaultChannelId: z.string().nullable().default(null),
  /** Per-kind channel overrides. */
  channels: channelMap,
  /** Which kinds are delivered to channels at all. DB persistence happens regardless. */
  enabledKinds: z
    .object(Object.fromEntries(LOG_KINDS.map((k) => [k, z.boolean().default(true)])) as Record<string, z.ZodType<boolean>>)
    .default(
      Object.fromEntries(LOG_KINDS.map((k) => [k, true])) as Record<string, boolean>
    )
});

export type LoggingSettings = z.infer<typeof loggingSettingsSchema>;

export const loggingSettingsDefaults: LoggingSettings = {
  defaultChannelId: null,
  channels: {},
  enabledKinds: Object.fromEntries(LOG_KINDS.map((k) => [k, true])) as Record<string, boolean>
};
