import { PermissionFlagsBits, type Guild } from 'discord.js';

export interface HierarchyResult {
  ok: boolean;
  reason?: 'target_owner' | 'target_admin_bot_not' | 'target_role_above_bot' | 'bot_same_as_target';
}

/**
 * Minimal structural view of Discord objects so this module is unit-testable
 * without constructing real discord.js instances.
 */
export interface BotLike {
  user: { id: string };
  highestRole: { position: number };
  permissions: { has(bits: bigint): boolean };
}

export interface TargetLike {
  id: string;
  highestRole: { position: number };
  permissions: { has(bits: bigint): boolean };
}

/**
 * Can the bot act on `target`?
 *
 * Discord rules encoded here (defensively — the API still enforces them,
 * but we pre-check so users get a clean error instead of an API failure):
 *  - the server owner is never mod-able;
 *  - an admin member cannot be moderated by a non-admin bot;
 *  - a non-admin target's highest role must be strictly below the bot's
 *    highest role.
 */
export function canBotActOnTarget(
  bot: BotLike,
  target: TargetLike,
  guild: Pick<Guild, 'ownerId'>
): HierarchyResult {
  if (target.id === bot.user.id) return { ok: true };
  if (guild.ownerId && target.id === guild.ownerId) return { ok: false, reason: 'target_owner' };

  const targetIsAdmin = target.permissions.has(PermissionFlagsBits.Administrator);
  const botIsAdmin = bot.permissions.has(PermissionFlagsBits.Administrator);

  if (targetIsAdmin && !botIsAdmin) return { ok: false, reason: 'target_admin_bot_not' };

  if (!targetIsAdmin && !botIsAdmin) {
    if (target.highestRole.position >= bot.highestRole.position) {
      return { ok: false, reason: 'target_role_above_bot' };
    }
  }
  return { ok: true };
}

/**
 * Does the invoking member have the command's required permission?
 * Owner and Administrator are treated as having any permission.
 */
export function memberHasPermission(
  member: { id: string; permissions: { has(bits: bigint): boolean } } | null,
  guild: Pick<Guild, 'ownerId'>,
  requiredPermission: bigint | null | undefined
): { ok: boolean; reason?: 'not_in_guild' | 'missing_permission' | 'missing_role' } {
  if (!member) return { ok: false, reason: 'not_in_guild' };
  if (!requiredPermission) return { ok: true };
  if (guild.ownerId && member.id === guild.ownerId) return { ok: true };
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return { ok: true };
  if (member.permissions.has(requiredPermission)) return { ok: true };
  return { ok: false, reason: 'missing_permission' };
}

export function memberHasRole(
  member: { roles: { cache: { has(id: string): boolean } } } | null,
  roleId: string | null | undefined
): { ok: boolean; reason?: 'not_in_guild' | 'missing_role' } {
  if (!roleId) return { ok: true };
  if (!member) return { ok: false, reason: 'not_in_guild' };
  if (member.roles.cache.has(roleId)) return { ok: true };
  return { ok: false, reason: 'missing_role' };
}
