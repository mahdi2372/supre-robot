# HTTP API & Dashboard

The bot process also runs an Express 4 API + a server-rendered dashboard on
`API_HOST:API_PORT` (default `0.0.0.0:3000`).

Cross-cutting behavior:

- **helmet** security headers, `x-powered-by` disabled.
- **CORS**: same-origin only (dashboard is served from this app).
- **Rate limiting**: per-IP — `REQUEST_RATE_LIMIT_PER_MINUTE` for `/api/*`
  (default 300), 120/min for `/dashboard/*`.
- **Request IDs**: every response carries an `X-Request-Id`; structured logs
  include it.
- **JSON 404** and a **centralized error handler** — unknown routes return
  `{ "error": { "code": "NOT_FOUND", ... } }`; malformed JSON bodies return 400
  (never 500); Zod validation failures return 400 with `INVALID_INPUT`.

Error shape (all endpoints):

```json
{ "error": { "code": "RATE_LIMITED", "message": "rate limit exceeded" } }
```

Common codes: `NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_INPUT`, `RATE_LIMITED`,
plus module error codes (e.g. `DISCORD_API`).

## Authentication

Three audiences:

1. **Unauthenticated** — public health only.
2. **Dashboard session (OAuth2)** — Discord login issues an `httpOnly`,
   `SameSite=Lax`, `Secure`(in prod) cookie (`supre_session`). The token is
   random 256-bit; only its sha256 is stored (`dashboard_sessions`).
   Sessions last 7 days and only ever see **guilds from the logged-in user's
   own Discord account** (fetched server-side via the OAuth token — the
   client's claims are never trusted).
3. **Admin API key** — `X-Api-Key` header, constant-time compared, for trusted
   server-to-server clients. Currently accepted on `/api/v1/status`.

### OAuth2 flow

- `GET /api/v1/auth/login` → issues a short-lived `state` (cached 10 min) and
  redirects to `https://discord.com/oauth2/authorize` (scope
  `identify guilds`).
- `GET /api/v1/auth/callback?code=…&state=…` → verifies `state` (CSRF),
  exchanges the code for a token, fetches the user + guilds, creates a session,
  sets the cookie, redirects to `/dashboard`.
- `POST /api/v1/auth/logout` → destroys the session, clears the cookie,
  redirects to login.

## Public endpoints

### `GET /api/v1/health`

Liveness probe (used by the Docker healthcheck). No auth.

```json
{ "status": "ok", "uptimeMs": 123456, "time": "2026-09-20T00:00:00.000Z" }
```

### `GET /api/v1/status`

Auth: admin API key **or** dashboard session. Live operational snapshot.

```json
{
  "version": "production",
  "bot":      { "status": "ready", "version": "0.1.0", "uptimeMs": 0, "latencyMs": 0, "username": "Supre", "guildCount": 3 },
  "database": { "connected": true, "lastPingMs": 4 },
  "modules":  { "core": { "status": "ready", "version": "0.1.0" } },
  "errors":   { "last30Min": 0, "ratePerMinute": 0 },
  "commands": { "total": 120 }
}
```

## Server settings API (session required)

All routes under `/api/v1/servers`. Unauthenticated requests get a JSON 401.
A session may only ever read/touch guilds present in **its own** OAuth guild
list; writes additionally require **ManageGuild** in that guild (or ownership).

| Route | Description |
| --- | --- |
| `GET /api/v1/servers` | The user's guilds (id, name, owner, icon). |
| `GET /api/v1/servers/:guildId` | Guild summary + per-module `{enabled, settings}` (defaults merged, schema-validated) + 24h stats (open tickets/cases, security events, logs). |
| `PATCH /api/v1/servers/:guildId/modules/:module` | Body: `{ "enabled"?: boolean, "settings"?: object }`. Merges over current settings and validates against the module's zod schema before writing. `core` cannot be disabled; unknown modules → 400. Returns `{ ok, module, enabled, settings }`. |
| `GET /api/v1/servers/:guildId/logs?limit=&kind=` | Audit log (newest first, 1–200, default 50). `kind` filters (e.g. `mod_action`, `security`, `config`). Log payloads are sanitized (secrets stripped) before response. |

Example:

```bash
curl -X PATCH "$BASE/api/v1/servers/$GUILD/modules/automod" \
  -H 'Cookie: supre_session=…' -H 'Content-Type: application/json' \
  -d '{"settings": {"flood": {"maxMessages": 10}}}'
```

## Dashboard (HTML)

Server-rendered pages under `/dashboard` (session required; unauthenticated
browsers are redirected to the OAuth login).

| Route | Description |
| --- | --- |
| `GET /` | Redirects to `/dashboard`. |
| `GET /dashboard` | Server list from the user's own session. |
| `GET /dashboard/servers/:guildId` | Module cards (enable/disable) + settings summary + recent logs. |
| `POST /dashboard/servers/:guildId/modules/:module` | Form: `csrf` + `action=enable|disable`. |

Security:

- **CSRF**: every mutation is a same-site POST carrying a `csrf` token =
  `HMAC(SESSION_SECRET, sha256(session token))` — deterministic, no extra
  storage; mismatch → 403.
- **XSS**: all dynamic content (guild names, module output) is HTML-escaped on
  render; there is no client-side template interpolation of untrusted data.
- **Authorization**: the target guild must belong to the session user's guild
  list, and ManageGuild/ownership is re-checked server-side per request.

## Adding an endpoint

1. Put it in `src/api/routes/` as an Express `Router` receiving `ApiDeps`.
2. Wrap async handlers with `ah()` (Express 4 does not forward async rejections).
3. Mount it in `createApiApp` under `/api/v1`, behind the right auth middleware.
4. Add a supertest case in `tests/api.test.ts`.
