# Deployment

## 1. Create the Discord application

1. [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**.
2. **Bot** tab:
   - **Reset Token** → copy into `DISCORD_TOKEN`.
   - Enable **Privileged Gateway Intents**:
     - `Server Members` (welcome/leave, role management)
     - `Message Content` (auto-moderation and message logging read content)
     - `Voice States` (music: voice-channel tracking and leave handling)
   - Invite the bot with the `bot` + `applications.commands` scopes and
     permissions: `Manage Roles`, `Manage Channels`, `Kick Members`,
     `Ban Members`, `Moderate Members`, `Manage Messages`, `Send Messages`,
     `Embed Links`, `Read Message History`, `Connect`, `Speak`.
3. **OAuth2 → General**: copy **Client ID** / **Client Secret** into
   `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
4. **OAuth2 → Redirects**: add your public callback URL **exactly**:
   ```
   https://your-domain.example/api/v1/auth/callback
   ```
   It must match `PUBLIC_BASE_URL` + `/api/v1/auth/callback`.

## 2. Configure the environment

Copy `.env.example` to `.env` (the compose file reads it from the working
directory). Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, and `PUBLIC_BASE_URL` (the compose
file wires `DATABASE_URL`/`REDIS_URL` for you).

Generate a session secret:

```bash
openssl rand -hex 32
```

See [CONFIGURATION.md](CONFIGURATION.md) for every variable and its rules.

## 3. Run with Docker Compose (recommended)

```bash
docker compose up -d --build
docker compose logs -f bot
```

The stack runs:

- **postgres:16-alpine** — data volume `pgdata`; not port-exposed by default.
- **redis:7-alpine** — cache; not port-exposed by default.
- **bot** — built from `Dockerfile` (multi-stage: build → minimal alpine
  runtime, non-root user, `npm ci --omit=dev`). Waits for both services to be
  healthy, runs migrations on startup, and listens on `3000`.

Both the image and the service have healthchecks against
`GET /api/v1/health`.

To develop against a locally ported Postgres, uncomment the `ports:` block on
the `postgres` service and point `DATABASE_URL` at `localhost:5432`.

## 4. Run without Docker

```bash
npm ci
npm run db:migrate
npm run build
NODE_ENV=production npm start
```

Requires a reachable Postgres (migrations run on boot when
`DATABASE_AUTO_MIGRATE=true`) and, optionally, Redis.

**Audio (music module):** the music stack is pure-npm — `opusscript`
(pure-JS Opus encoder), `libsodium-wrappers`, and the `discord-voip`/
`discord-player` voice layer — so no build toolchain is needed. Stream
conversion uses **ffmpeg**, resolved in this order: `FFMPEG_PATH` env var,
`ffmpeg` on `PATH`, then the npm packages (`@ffmpeg-installer/ffmpeg`,
`ffmpeg-static`). The stock `Dockerfile` (node:22-alpine) therefore installs
the **system ffmpeg via apk** — the `ffmpeg-static` npm binary is glibc-only
and cannot run on musl. For non-Docker deployments on glibc Linux, the
`ffmpeg-static` postinstall (run during `npm ci`) provides the binary
automatically; installs with `--ignore-scripts` and no system ffmpeg will
fail at play time. The queue itself is in-memory, so it needs no extra
runtime dependency.

## 5. Production checklist

- [ ] `NODE_ENV=production` (enables `Secure` session cookies).
- [ ] `PUBLIC_BASE_URL` is the real `https://` URL and matches the registered
      OAuth redirect exactly.
- [ ] `SESSION_SECRET` is 64 random hex chars and rotated if the dashboard
      ever leaks (rotating it invalidates all sessions — intended).
- [ ] `ADMIN_API_KEY` set if `/api/v1/status` is exposed; treat it like a
      password.
- [ ] TLS terminated in front of the container (the process serves plain HTTP;
      put a reverse proxy / load balancer in front).
- [ ] Postgres data volume backed up; `pgdata` is the only state besides the
      Discord app itself.
- [ ] `REQUEST_RATE_LIMIT_PER_MINUTE` tuned to your traffic.
- [ ] Logs shipped (JSON on stdout) and `LOG_LEVEL=info` (use `debug`
      temporarily while diagnosing).
- [ ] `DISCORD_GUILD_ID` left **unset** in production (global command
      registration).

## 6. Updates & migrations

- Rebuild and redeploy: `docker compose up -d --build`.
- Migrations are additive and checksummed; they run automatically on startup.
  Never edit an applied migration file — add a new one. Verify integrity any
  time with `npm run db:verify`.
- Rollback of an image is straightforward (state lives in Postgres); rolling
  back *schema* is intentionally not supported — migrations are forward-only
  to protect production data.

## 7. Observability

- **Health**: `GET /api/v1/health` (liveness).
- **Status**: `GET /api/v1/status` with `X-Api-Key` (bot, DB, modules, errors,
  command metrics).
- **Logs**: JSON on stdout, one object per line, with `requestId` on API
  activity and secret redaction.
- **Audit**: the `bot_logs` table (moderation, security, config events) is
  queryable via `GET /api/v1/servers/:guildId/logs` and the dashboard; pruned
  after `LOG_RETENTION_DAYS`.
