import { describe, expect, it } from 'vitest';
import { canBotActOnTarget, memberHasPermission, memberHasRole } from '../src/core/permissions.js';
import { PermissionFlagsBits } from 'discord.js';

const Ban = PermissionFlagsBits.BanMembers;

function member({
  id = 'u1',
  position = 0,
  admin = false,
  perms = []
}: {
  id?: string;
  position?: number;
  admin?: boolean;
  perms?: bigint[];
} = {}) {
  return {
    id,
    highestRole: { position },
    permissions: {
      has: (bits: bigint) => (admin ? true : perms.includes(bits))
    }
  };
}

const bot = (position: number, admin = false) => ({
  user: { id: 'bot' },
  highestRole: { position },
  permissions: { has: (_b: bigint) => (admin ? true : false) as unknown as boolean }
});

describe('canBotActOnTarget', () => {
  it('allows acting on lower-privileged members', () => {
    const r = canBotActOnTarget(bot(10), member({ position: 5 }), { ownerId: 'owner' });
    expect(r.ok).toBe(true);
  });

  it('refuses to act on the server owner', () => {
    const r = canBotActOnTarget(bot(100, true), member({ id: 'owner', position: 200, admin: true }), {
      ownerId: 'owner'
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('target_owner');
  });

  it('refuses when target has admin but the bot does not', () => {
    const r = canBotActOnTarget(bot(100), member({ admin: true, position: 1 }), { ownerId: 'owner' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('target_admin_bot_not');
  });

  it('allows an admin bot to act on an admin target', () => {
    const r = canBotActOnTarget(bot(10, true), member({ admin: true, position: 200 }), { ownerId: 'owner' });
    expect(r.ok).toBe(true);
  });

  it('refuses when target role is at or above bot role (neither admin)', () => {
    expect(canBotActOnTarget(bot(10), member({ position: 10 }), { ownerId: 'o' }).ok).toBe(false);
    expect(canBotActOnTarget(bot(10), member({ position: 11 }), { ownerId: 'o' }).reason).toBe('target_role_above_bot');
  });

  it('allows acting on self', () => {
    expect(canBotActOnTarget(bot(1), member({ id: 'bot', position: 50 }), { ownerId: 'o' }).ok).toBe(true);
  });
});

describe('memberHasPermission', () => {
  const guild = { ownerId: 'owner' };

  it('allows when no permission required', () => {
    expect(memberHasPermission(member({}), guild, null).ok).toBe(true);
  });

  it('allows owner of any permission', () => {
    expect(memberHasPermission(member({ id: 'owner' }), guild, Ban).ok).toBe(true);
  });

  it('allows admin of any permission', () => {
    expect(memberHasPermission(member({ admin: true }), guild, Ban).ok).toBe(true);
  });

  it('denies members without the permission', () => {
    const r = memberHasPermission(member({}), guild, Ban);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_permission');
  });

  it('allows members with the exact permission', () => {
    expect(memberHasPermission(member({ perms: [Ban] }), guild, Ban).ok).toBe(true);
  });

  it('denies when the member is unknown (DM context)', () => {
    expect(memberHasPermission(null, guild, Ban).reason).toBe('not_in_guild');
  });
});

describe('memberHasRole', () => {
  it('passes when no role required', () => {
    expect(memberHasRole(null, null).ok).toBe(true);
  });

  it('checks role membership', () => {
    const m = { roles: { cache: { has: (id: string) => id === 'r1' } } };
    expect(memberHasRole(m, 'r1').ok).toBe(true);
    expect(memberHasRole(m, 'r2').ok).toBe(false);
    expect(memberHasRole(null, 'r1').reason).toBe('not_in_guild');
  });
});
