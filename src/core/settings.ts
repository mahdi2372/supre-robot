import { z } from 'zod';
import type { CacheStore } from '../cache/types.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor } from '../types/index.js';

export interface ModuleSettingsSpec<T extends Record<string, unknown>> {
  /** Zod schema; .parse() must yield the full settings object with defaults. */
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  defaults: T;
}

const CACHE_TTL_SECONDS = 60;

/**
 * Central settings service.
 *
 * - every module declares a zod schema for its settings;
 * - guild overrides live in guild_settings (jsonb), merged over defaults;
 * - the merged result is always validated, so a corrupted row can never
 *   reach module code;
 * - reads are cached (Redis or memory) with a short TTL and invalidated on
 *   write.
 */
export class SettingsService {
  private readonly specs = new Map<string, ModuleSettingsSpec<Record<string, unknown>>>();

  constructor(
    private readonly db: QueryExecutor,
    private readonly cache: CacheStore,
    private readonly logger: Logger
  ) {}

  register<T extends Record<string, unknown>>(module: string, spec: ModuleSettingsSpec<T>): void {
    if (this.specs.has(module)) {
      throw new Error(`settings schema for module '${module}' already registered`);
    }
    this.specs.set(module, spec as ModuleSettingsSpec<Record<string, unknown>>);
  }

  knownModules(): string[] {
    return [...this.specs.keys()];
  }

  getSchema(module: string): ModuleSettingsSpec<Record<string, unknown>> | undefined {
    return this.specs.get(module);
  }

  private cacheKey(guildId: string, module: string): string {
    return `settings:${guildId}:${module}`;
  }

  /**
   * Get validated settings for (guild, module): defaults merged with the
   * stored override. Unknown modules return their registered defaults.
   */
  async get<T extends Record<string, unknown>>(guildId: string, module: string): Promise<T> {
    const spec = this.specs.get(module);
    if (!spec) throw new Error(`settings for unknown module '${module}' requested`);

    const key = this.cacheKey(guildId, module);
    const cached = await this.cache.get<string>(key);
    if (cached !== undefined) {
      try {
        return spec.schema.parse(JSON.parse(cached)) as unknown as T;
      } catch {
        // fall through and re-read
      }
    }

    let row: { settings: Record<string, unknown> } | undefined;
    try {
      const res = await this.db.query<{ settings: string | Record<string, unknown> }>(
        'SELECT settings FROM guild_settings WHERE guild_id = $1 AND module_key = $2',
        [guildId, module]
      );
      const raw = res.rows[0];
      if (raw) row = { settings: (typeof raw.settings === 'string' ? JSON.parse(raw.settings) : raw.settings) ?? {} };
    } catch (err) {
      this.logger.error({ err: { message: (err as Error).message }, guildId, module }, 'settings read failed');
      throw err;
    }

    const merged = { ...spec.defaults, ...(row?.settings ?? {}) } as Record<string, unknown>;
    const parsed = spec.schema.parse(merged) as unknown as T;
    await this.cache.set(key, JSON.stringify(parsed), CACHE_TTL_SECONDS).catch(() => undefined);
    return parsed;
  }

  /**
   * Update settings for (guild, module). `patch` is merged over the current
   * value and the whole merged object is validated before writing — a patch
   * that would produce an invalid configuration is rejected.
   */
  async set<T extends Record<string, unknown>>(
    guildId: string,
    module: string,
    patch: Partial<T>,
    actorId: string | null
  ): Promise<T> {
    const spec = this.specs.get(module);
    if (!spec) throw new Error(`settings for unknown module '${module}' written`);

    const current = await this.get<Record<string, unknown>>(guildId, module);
    const merged = { ...current, ...patch };
    const parsed = spec.schema.parse(merged) as unknown as T;

    try {
      await this.db.query(
        `INSERT INTO guild_settings (guild_id, module_key, enabled, settings, updated_by)
         VALUES ($1, $2, TRUE, $3, $4)
         ON CONFLICT (guild_id, module_key)
         DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [guildId, module, JSON.stringify(parsed), actorId]
      );
    } catch {
      // First use in a fresh server may race with servers-row creation.
      await this.db
        .query(
          `INSERT INTO servers (guild_id, name) VALUES ($1, $1)
           ON CONFLICT (guild_id) DO NOTHING`,
          [guildId]
        )
        .catch(() => undefined);
      await this.db.query(
        `INSERT INTO guild_settings (guild_id, module_key, enabled, settings, updated_by)
         VALUES ($1, $2, TRUE, $3, $4)
         ON CONFLICT (guild_id, module_key)
         DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [guildId, module, JSON.stringify(parsed), actorId]
      );
    }
    await this.cache.del(this.cacheKey(guildId, module)).catch(() => undefined);
    return parsed;
  }

  /** Module enabled state for a guild. Modules are enabled by default. */
  async isEnabled(guildId: string, module: string): Promise<boolean> {
    try {
      const res = await this.db.query<{ enabled: boolean }>(
        'SELECT enabled FROM guild_settings WHERE guild_id = $1 AND module_key = $2',
        [guildId, module]
      );
      return res.rows[0]?.enabled ?? true;
    } catch {
      // If the DB is down, defaulting to enabled matches fresh-server
      // behavior and avoids taking the whole bot down with a settings read.
      return true;
    }
  }

  /** Set enabled flag (module row only; settings untouched). */
  async setEnabled(guildId: string, module: string, enabled: boolean, actorId: string | null): Promise<void> {
    await this.db
      .query('INSERT INTO servers (guild_id, name) VALUES ($1, $1) ON CONFLICT (guild_id) DO NOTHING', [guildId])
      .catch(() => undefined);
    await this.db.query(
      `INSERT INTO guild_settings (guild_id, module_key, enabled, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, module_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [guildId, module, enabled, actorId]
    );
    await this.cache.del(this.cacheKey(guildId, module)).catch(() => undefined);
  }

  /**
   * Ensure the servers row exists (FK target for all guild-scoped tables).
   * Called lazily by modules before their first write.
   */
  async ensureGuild(guildId: string, guildName?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO servers (guild_id, name) VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET name = EXCLUDED.name, member_count = GREATEST(servers.member_count, 0)`,
      [guildId, guildName ?? guildId]
    );
  }
}
