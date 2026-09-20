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

## Ticket issues

- **"You already have N open ticket(s)"** — the per-user limit
  (`maxOpenPerUser`, default 1) counts tickets with status `open`. A ticket
  whose channel was deleted while the bot was down is marked closed at the
  next startup (reason `channel deleted`), which frees the slot; otherwise
  staff can close it with `/ticket close`.
- **Ticket channel not created** — the bot needs **Manage Channels** in the
  guild (and Manage Roles is not required). If channel creation fails, the
  allocated ticket row is rolled back, so no orphan numbers accumulate.
- **Transcript empty on close** — capture only starts while the ticket is
  open, the module is enabled, and the channel is still named `ticket-<n>`
  (capture is pre-filtered on the name; renaming a ticket channel stops
  capture). Bot messages are skipped; messages sent before the ticket
  existed are not part of it. Captured content is truncated at 2000
  characters; attachments have no text.
- **Transcript fence looks mangled** — user content containing triple
  backticks is replaced with `'''` so it can never break out of the code
  block.
- **Channel deleted seconds after "closed"** — expected: the close delay
  (`closeDelaySeconds`, default 5) is the last-chance window to read the
  closing message. Set it to 0 for immediate deletion.

## Music issues

- **Queue is gone after a restart** — by design. The queue is in-memory
  (per guild, per process); only the playback *policy* (volume, caps, idle
  timeout, manage role) is persisted. If the queue must survive restarts,
  that is a feature to build, not a misconfiguration.
- **"Could not play that" / nothing streams** — the extractor could not
  resolve the query (removed/unavailable track, dead link, or the source's
  API changed). Single tracks fail per-track; the rest of the queue keeps
  playing. Check the bot logs for a `music: play failed` /
  `music: track playback error` line with the underlying error.
- **Bot won't join voice / silent output** — the bot needs **Connect** and
  **Speak** on the target channel, and (on voice) no per-channel mute.
  Audio is encoded with the pure-JS `opusscript` encoder (no native build
  toolchain). Stream conversion needs an **ffmpeg** binary, found in this
  order: `FFMPEG_PATH`, `ffmpeg` on `PATH` (the stock Docker image installs
  it via apk, since the `ffmpeg-static` npm binary is glibc-only and won't
  run on alpine), then the npm fallbacks. If none exist, playback fails at
  play time (see DEPLOYMENT.md).
- **Track longer than the limit is skipped** — `maxTrackSeconds`
  (0 = unlimited) drops non-live tracks over the cap when a search or
  playlist is added. It is a queue-hygiene guard, applied once per add.
- **Bot stays in the channel after stop** — expected: `/music stop` clears
  the queue but leaves after the idle timeout (`idleTimeoutSeconds`,
  default 300). `/music leave` disconnects immediately; the bot also
  leaves whenever the voice channel empties.
- **Controls rejected with a permission error** — queue controls require
  Manage Server, or being in the same voice channel as the bot (plus the
  module's `manageRoleId` role when set). `/music play`, `/music queue`
  and `/music now` are open to anyone.
- **Bot never joins / never leaves voice channels, or the log warns
  `client is missing "GuildVoiceStates" intent`** — the **Voice States**
  privileged intent is not enabled in the Developer Portal (Bot tab).
  The player relies on voice-state events for joining, reconnection and
  empty-channel leave handling; without the intent, music will not work.
- **`Could not load youtube library` in the logs** — the YouTube extractor
  streams through `youtube-ext` (installed as a dependency). If you run a
  custom install, make sure `youtube-ext` (or one of `ytdl-core`,
  `@distube/ytdl-core`, `play-dl`, `yt-stream`) is present; force a choice
  with `DP_FORCE_YTDL_MOD=<lib>`.

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
