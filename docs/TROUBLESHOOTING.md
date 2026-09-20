# Troubleshooting

General approach: the bot logs JSON to stdout with a `level`. Start with
`LOG_LEVEL=info` (or temporarily `debug`), filter for the area in question, and
check `/api/v1/status` (with `X-Api-Key`) for the bot/DB/module snapshot.

## Commands don't appear in Discord

- **Global registration is slow.** Without `DISCORD_GUILD_ID`, Discord caches
  global commands for up to an hour. For development, set `DISCORD_GUILD_ID` —
  guild-scoped registration is instant.
- **Registration failed at boot.** Look for `command registration failed —
  check token/permissions` in the logs: the token is invalid, or the bot lacks
  the `applications.commands` scope / `Manage Guild` in that guild.
- **New command still missing after redeploy.** The bot re-registers its full
  command set on every startup; a restart is usually enough. Check the logs for
  the `commands registered` line (`{ scope, count }`).

## The bot is online but "blind" to messages

- **Message Content intent not enabled.** Auto-moderation, message logging, and
  custom `args` need the **Message Content** privileged intent — enable it in
  Developer Portal → Bot, then restart the bot.
- **Server Members intent not enabled.** Welcome/leave and role operations need
  it (also privileged).
- The bot must be **invited into the guild** with the required permissions
  (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## OAuth login fails / redirect errors

- **"Invalid redirect URI"** (or Discord refuses the callback):
  `PUBLIC_BASE_URL` + `/api/v1/auth/callback` does not **exactly** match a
  registered redirect in Developer Portal → OAuth2 → Redirects (scheme, host,
  port, and path must all match).
- **`/dashboard?error=invalid_state`**: the `state` was missing/expired (10
  min TTL) — usually a stale tab or a cache (Redis) that was flushed. Retry the
  login.
- **Login succeeds but no guilds show**: the user's account has no guilds with
  the requested scopes, or the `guilds` scope fetch failed. Confirm the user is
  actually a member (ideally an admin) of the target server.

## "Invalid environment configuration" at boot

The config validator lists **every** problem in one line. Common ones:
`SESSION_SECRET` shorter than 32 chars, missing `DISCORD_TOKEN`/`DATABASE_URL`,
`DISCORD_GUILD_ID` not a snowflake, or `PUBLIC_BASE_URL` not a valid URL. Fix
the env and restart — the process deliberately refuses to boot on bad config.

## Database unreachable at boot

The bot starts in **DEGRADED mode** (logged as `database unreachable at boot —
starting in DEGRADED mode`): the API/health still serve, but migrations,
persistence, and durable jobs are disabled until the DB is reachable. Fix
connectivity (credentials, network, `DATABASE_URL`) and restart. If a
migration fails instead, the process exits with `migration failed — aborting`
and no data is modified.

## "…was modified after being applied (checksum mismatch)"

An applied migration file was edited. This is a hard stop by design
(protecting production data). Restore the original file content, or add a new
migration for the change — never rewrite applied migrations. Verify integrity
with `npm run db:verify`.

## A module shows `error` in `/status`

Module failures are isolated: the rest of the bot keeps running. Find the
module's boot error in the logs (search for its name), fix, and restart. The
module re-initializes on the next boot.

## "not a member of that server" / "ManageGuild permission required" from the dashboard

Expected behavior, not a bug: a dashboard session can only act on guilds from
**its own** Discord account, and writes need ManageGuild (or ownership) in
that guild. Use the correct Discord account with the right role.

## Dashboard CSRF error on save

The `csrf` form field didn't match the session. Usually a stale page — reload
the dashboard page and try again. (The token is derived from the session
cookie; it can't be "reset" separately.)

## Settings change not taking effect

- Settings reads are cached for **60 seconds** and invalidated on write. If you
  changed a value via a path that bypasses the settings service, wait out the
  TTL or restart.
- If the DB is down, `isEnabled` degrades to `true`; values can't be read and
  modules run on defaults until the DB returns.
- A settings row that fails its zod schema is rejected (it can never reach
  module code). Check the API/dashboard response for `INVALID_INPUT` and fix
  the value.

## Custom command doesn't fire

- Custom commands are registered per-guild at boot; add one and **restart** (or
  wait for the next registration) so Discord knows the name.
- Check `/customlist` — the command may be disabled, or gated by a
  `role`/`permission` you don't satisfy, or on cooldown.
- The template uses **double braces**: `{{user}}`, `{{args}}`, etc. Single
  braces (`{user}`) are rendered literally.

## Flood of `RATE_LIMITED` from the API

The per-IP limit (`REQUEST_RATE_LIMIT_PER_MINUTE`, default 300) was hit. This
is protection, not a fault — raise the limit only if your legitimate traffic
justifies it, and check whether a client is polling too aggressively.

## Multiple instances behind a load balancer

Each instance needs the **same** `DATABASE_URL` and a **shared Redis**
(`REDIS_URL`). Without Redis, each instance has its own cache and OAuth
`state`, so logins/invalidations won't be coherent across instances. Sessions
are DB-backed and therefore already shared.

## Testing notes (pg-mem)

The integration suite runs real SQL through the real pg driver against pg-mem.
Known engine limitations (worked around in tests; production SQL stays
Postgres-correct):

- `FOR UPDATE SKIP LOCKED` is unsupported → the scheduler's claim query is
  injectable, and the integration test uses plain `FOR UPDATE`.
- The in-process adapter has no per-connection SQL transaction state →
  transaction tests assert the statement sequence (BEGIN/COMMIT/ROLLBACK) the
  executor issues, not data-level rollback.
- Re-running `CREATE TABLE IF NOT EXISTS` with constraints is rejected →
  `runMigrations` probes for the table's presence when the DDL errors (on real
  Postgres this path never triggers).

If you add a feature, prefer plain SQL that pg-mem supports so it stays covered
by the integration suite; isolate anything exotic behind an injectable seam.
