# Security

Supre Robot treats the bot, its API, and the Discord surface as one security
boundary. This document describes the threat model and the concrete controls.

## Threat model

- **Malicious Discord users** who can send messages, invoke commands, and craft
  user-controlled strings (names, message content, custom command templates).
- **A malicious/compromised browser** with a valid dashboard session (CSRF,
  XSS) trying to mutate other guilds.
- **Untrusted network clients** hitting the HTTP API (rate abuse, probing).
- **A compromised/modified deployment** (tampered migrations, leaked env).
- **Partial outages** (DB/Redis down) that must not become a total outage or a
  data-integrity hole.

The core invariants:

1. **Client claims are never trusted.** The invoking user's guild membership,
   permissions, and ownership are re-read from the Discord API / the OAuth
   guild list **server-side** on every privileged action.
2. **Secrets never leave the process.** Not into logs, the audit DB, or API
   responses.
3. **A failing module or a down dependency degrades gracefully** — it does not
   take the whole bot down or corrupt data.

## Authentication & sessions

- **Discord OAuth2** with a short-lived `state` (cached 10 min) for CSRF
  protection on the callback.
- Session tokens are 256-bit random; **only the sha256 is stored** in
  `dashboard_sessions` (a DB leak does not yield usable cookies).
- Session cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production, 7-day
  expiry.
- A session only ever sees **guilds from the logged-in user's own account**,
  fetched server-side via the OAuth token. The client's self-reported guild
  list is ignored.
- **Admin API key** (`X-Api-Key`) for trusted server-to-server clients,
  compared **in constant time** (sha256 both sides + `timingSafeEqual`) so
  timing does not leak the key.

## Authorization

- **Discord commands**: `requiredPermission` (a Discord permission flag) and
  optional `requiredRoleId` are enforced **server-side, always** — never
  relied on client-side. Targets must be real guild members resolvable
  server-side.
- **Moderation power**: `canBotActOnTarget` checks the bot can actually act on
  the target (higher-role ordering, not bot/admin), preventing the bot from
  "moderating" accounts it cannot touch.
- **API/dashboard writes**: require ManageGuild in the *target* guild (or
  ownership), re-checked per request. A session for guild A can never touch
  guild B.

## Input handling

- **Safe templating** (`utils/templating.ts`): admin-authored templates support
  only `{{name}}` / `{{a.b}}` variable lookups. No loops, conditionals, function
  access, or code evaluation — a template **cannot execute arbitrary code**.
  Unknown variables render empty (or as the literal placeholder when
  `missing: 'keep'`).
- **Discord-markdown escaping** for user/admin-supplied text so substituted
  content can't inject formatting into bot messages.
- **Zod validation** at every boundary: config, module settings (on read *and*
  write), and API request bodies. A corrupted or hostile settings row can never
  reach module code.
- **SQL injection**: all SQL is parameterized (Postgres `$1…$n` placeholders);
  user input is never string-concatenated into queries. Migrations are static
  files, checksummed, and immutable once applied.
- **Log/audit sanitization** (`security/sanitize.ts`): recursive redaction of
  sensitive keys (`token`, `secret`, `password`, `api_key`, `authorization`,
  `cookie`, `credential`, `session`, …) before anything is written to
  `bot_logs` or structured logs, with depth/size caps to bound memory.
- **pino redact** list covers process logs as a second, independent layer.

## Web (API/dashboard) hardening

- **helmet** security headers; `x-powered-by` disabled.
- **CORS** restricted to same-origin (the dashboard is served by this app).
- **Rate limiting** per IP for both the API and dashboard.
- **CSRF** on dashboard mutations: a per-session token
  (`HMAC(SESSION_SECRET, sha256(session token))`); mismatch → 403.
- **XSS**: all dynamic HTML is escaped on render; no untrusted client-side
  interpolation.
- **Malformed bodies** → 400, never 500; async rejections are wrapped
  (`ah()`) and routed to a centralized error handler that returns stable,
  user-safe JSON (no stack traces).

## Data & availability

- **Additive, checksummed migrations**: applied files are immutable (sha256
  verified every run); editing one fails startup instead of silently re-applying.
- **Durable jobs** are persisted and re-claimed after restart; idempotency keys
  guard against double-spend on financial-style writes.
- **Graceful degradation**: if the DB is briefly unreachable, `isEnabled`
  defaults to `true` (fresh-server behavior) and best-effort side effects (e.g.
  sending a log embed) are isolated with `safeSideEffect` so they can't crash
  the process.
- **Non-root** container user, minimal alpine runtime, `npm ci --omit=dev`.

## Secrets & deployment

- All secrets come from the environment and are validated at startup
  (`SESSION_SECRET` ≥ 32 chars, `ADMIN_API_KEY` ≥ 16). The process refuses to
  boot with an invalid/weak environment.
- `.env` is git-ignored; `.env.example` ships only placeholders.
- The bot token, client secret, and DB credentials are **never logged** (pino
  redact + sanitize).

## What is intentionally out of scope (for now)

- No multi-tenant isolation beyond the guild/session boundary described above.
- Music/external-media fetching (when added) must go through a provider
  abstraction with URL allowlisting and egress controls — not yet implemented.
