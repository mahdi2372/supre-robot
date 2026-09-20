# Configuration

All configuration is read from environment variables and validated with zod at
startup (`src/config/index.ts`). The process **refuses to boot** with an invalid
environment — you get one clear error listing every problem, not a confusing
runtime failure later.

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

## Discord application

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | — | Bot token (Developer Portal → Bot → Reset Token). |
| `DISCORD_CLIENT_ID` | yes | — | OAuth2 application client ID (General Information). |
| `DISCORD_CLIENT_SECRET` | yes | — | OAuth2 application client secret. |
| `DISCORD_GUILD_ID` | no | — | When set (a snowflake), slash commands register only in that guild — instant, ideal for development. Unset = global registration (can take up to 1h). |

## Public URL

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | no | `http://localhost:3000` | Public base URL of the API/dashboard. Used to build the OAuth2 `redirect_uri` (`{base}/api/v1/auth/callback`) — must exactly match the redirect URL registered in the Discord application. Must be a valid URL; use `https://` in production. |

## Database

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string, e.g. `postgres://supre:supre@localhost:5432/supre_robot`. |
| `DATABASE_AUTO_MIGRATE` | no | `true` | Run additive, checksummed migrations automatically on startup (`true`/`false`). |
| `TEST_DATABASE_URL` | no | — | Test-only: a second database for the integration suite. |

Pool defaults (production-tuned, in `src/database/pool.ts`): max 10 connections,
10s statement timeout, 10s query timeout, 30s idle timeout.

Migrations live in `migrations/`, are additive-only, and are immutable once
applied (each applied file's sha256 checksum is stored and re-verified on every
run — editing an applied migration fails startup instead of silently re-applying).

## Cache

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `REDIS_URL` | no | — | e.g. `redis://localhost:6379`. When unset/empty, an in-process memory cache is used (single instance only — shared state like OAuth state and settings caches is lost across processes). |

## Security

| Variable | Required | Default | Description |
| --- | --- | --- | |
| `SESSION_SECRET` | yes | — | ≥ 32 characters. HMACs dashboard CSRF tokens. Generate: `openssl rand -hex 32`. |
| `ADMIN_API_KEY` | no | — | ≥ 16 characters. Static key for trusted server-to-server clients; accepted via `X-Api-Key` on `/api/v1/status` (see [API](API.md)). Compared in constant time. |

## API server

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_HOST` | no | `0.0.0.0` | Bind address. |
| `API_PORT` | no | `3000` | Bind port. |
| `REQUEST_RATE_LIMIT_PER_MINUTE` | no | `300` | Per-IP limit for the public API. Dashboard routes have a separate 120/min limit. |

## Logging

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LOG_LEVEL` | no | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. JSON output (pino). |
| `LOG_RETENTION_DAYS` | no | `30` | Days to keep `bot_logs` audit rows (a scheduled job prunes them). |

## Runtime

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production`. In production the session cookie is set `Secure`. |
| `API_ONLY` | no | `false` | Run only the API/dashboard — skips Discord gateway login and command registration. An ops convenience for debugging the web surface or for API-only instances. |

## Audio (music) — read by the libraries, not by the app

These are consumed directly by `discord-player` / the YouTube extractor, not
by Supre Robot's config schema (unknown keys are ignored at boot). Only set
them if you need to customize the audio stack:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FFMPEG_PATH` | no | auto-detect | Explicit path to an ffmpeg binary. Auto-detection order: `FFMPEG_PATH`, `ffmpeg` on `PATH` (the Docker image installs it via apk), `avconv`, then the npm fallbacks (`@ffmpeg-installer/ffmpeg`, `ffmpeg-static`). |
| `DP_FORCE_YTDL_MOD` | no | first found of `youtube-ext`, `ytdl-core`, `@distube/ytdl-core`, `play-dl`, `yt-stream` | Comma-separated list that forces (and re-orders) which YouTube streaming library the extractor uses. |

## Validation rules worth knowing

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DATABASE_URL`,
  `SESSION_SECRET` are mandatory — boot fails without them.
- `SESSION_SECRET` < 32 chars or `ADMIN_API_KEY` < 16 chars → boot fails.
- `DISCORD_GUILD_ID` must be a 10–20 digit snowflake if present.
- `PUBLIC_BASE_URL` must be a valid URL; `REDIS_URL` must be a valid URL if set.
- Invalid values produce a single startup error naming every offending variable.
