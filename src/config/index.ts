import { z } from 'zod';

/**
 * Central environment configuration.
 *
 * Every secret the process needs is validated here at startup. The process
 * refuses to boot with an invalid environment instead of failing later with
 * confusing errors.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_GUILD_ID: z.string().regex(/^\d{10,20}$/, 'DISCORD_GUILD_ID must be a snowflake').optional(),

  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  REDIS_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)'),

  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 characters').optional(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REQUEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  /**
   * Ops convenience: run only the API/dashboard (no Discord gateway login,
   * no command registration). Useful for debugging the web surface or for
   * API-only instances.
   */
  API_ONLY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  /** Only relevant in test environments: a second DATABASE_URL for integration tests. */
  TEST_DATABASE_URL: z.string().optional()
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }
  return parsed.data;
}
