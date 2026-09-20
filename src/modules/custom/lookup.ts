import type { QueryExecutor } from '../../types/index.js';
import type { CustomCommandRow } from './executor.js';

/**
 * Look up an enabled custom command for a guild (case-insensitive name).
 * Used by the interaction router before module commands so guild-specific
 * commands can exist alongside global ones.
 */
export async function findCustomCommandRow(
  db: QueryExecutor,
  guildId: string,
  name: string
): Promise<CustomCommandRow | undefined> {
  const res = await db.query<{
    id: string;
    name: string;
    response: string;
    required_role_id: string | null;
    required_permission: string | null;
    channel_ids: string[];
    cooldown_ms: number;
    enabled: boolean;
  }>(
    `SELECT id, name, response, required_role_id, required_permission,
            COALESCE(channel_ids, '{}') AS channel_ids, cooldown_ms, enabled
     FROM custom_commands
     WHERE guild_id = $1 AND lower(name) = lower($2)`,
    [guildId, name]
  );
  const row = res.rows[0];
  if (!row) return undefined;
  return {
    id: String(row.id),
    name: row.name,
    response: row.response,
    required_role_id: row.required_role_id,
    required_permission: row.required_permission,
    channel_ids: row.channel_ids,
    cooldown_ms: row.cooldown_ms,
    enabled: row.enabled
  };
}
