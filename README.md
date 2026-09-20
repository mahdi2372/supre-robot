# Supre Robot

A production-grade, modular Discord bot platform: moderation with case tracking and
an escalation ladder, auto-moderation with false-positive protection, support
tickets with transcripts, welcome/leave messages, custom commands with a safe
template engine, per-guild settings with a dashboard, an audit log service,
durable background jobs, and English + বাংলা i18n.

Built on Node.js 22, TypeScript (strict), discord.js 14, Express 4, and PostgreSQL.

## Features

- **Modular architecture** — every feature is an independently enableable module with
  its own zod-validated settings schema. A failing module never takes down the bot.
- **Moderation** — warn / ban (incl. temporary) / softban / kick / timeout / clear /
  slowmode / lock / unlock, atomic per-guild case numbers, an escalation ladder
  (warn → timeout → kick → ban), punishment expiry jobs, and an audit trail
  (`/case <number>`).
- **Auto-moderation** — pluggable detectors (caps, emoji, mentions, invites,
  suspicious URLs, banned words with zero-width-evasion resistance, custom regex,
  flood, duplicates, new-account signals) feeding a confidence policy where weak
  signals can never trigger a punishment alone.
- **Tickets** — private support channels with atomic per-guild numbering,
  per-user open limits, staff claims and member management, message capture
  with chunked transcripts, announcement channel, and restart reconciliation
  (`/ticket open|close|claim|add|remove|list|transcript|panel`).
- **Dashboard** — Discord OAuth2 login, per-guild settings management, HTML-escaped
  server-rendered pages, CSRF-protected writes.
- **Safe templating** — `{{var}}` templates with no code-evaluation surface;
  Discord-markdown escaping for user-supplied content.
- **Durable jobs** — scheduled tasks (punishment expiry, log cleanup, temp-role
  expiry) persisted to Postgres and re-claimed after restarts.
- **Observability** — pino JSON logs with secret redaction, request IDs, structured
  audit log, health + status endpoints.

## Requirements

- Node.js ≥ 22
- PostgreSQL ≥ 14
- A Discord application (bot + OAuth2) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Optional: Redis (otherwise an in-memory cache is used)

## Quickstart (development)

```bash
cp .env.example .env          # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID/SECRET, ...
npm install
npm run db:migrate            # apply SQL migrations (also runs on boot if DATABASE_AUTO_MIGRATE=true)
npm run dev                   # start bot + API
```

The API/dashboard serves on `http://localhost:3000` (`/api/v1/health` is the
public health check; `/` redirects to the dashboard).

Set `DISCORD_GUILD_ID` in `.env` to register slash commands instantly in one
guild while developing; leave it unset to register globally.

## Production

```bash
docker compose up -d --build
```

`docker-compose.yml` runs Postgres 16 + Redis 7 + the bot (migrations run
automatically on startup). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Scripts

| Script            | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `npm run dev`     | Run from source with tsx watch             |
| `npm run build`   | Compile to `dist/` (NodeNext ESM)          |
| `npm start`       | Run the compiled bot                       |
| `npm run db:migrate` | Apply database migrations only          |
| `npm run db:verify` | Verify checksums of applied migrations  |
| `npm run test:integration` | Run only the pg-mem integration tests |
| `npm test`        | Run the full vitest suite (unit + integration) |
| `npm run lint`    | ESLint over `src` and `tests`              |
| `npm run typecheck` | `tsc --noEmit`                         |

## Project layout

```
migrations/        additive, checksummed SQL migrations
src/
  config/          env parsing + validation (zod)
  core/            module system, settings service, permissions, interactions, metrics
  database/        pg pool, migration runner, executor abstraction
  modules/         core, config, custom, logging, moderation, welcome, automod
  api/             Express app, OAuth2 sessions, REST API, dashboard (HTML)
  jobs/            durable job scheduler + handlers
  services/        audit log service
  security/        input sanitization
  utils/           errors, safe templating, i18n (en, bn)
tests/             unit tests + pg-mem integration tests (real SQL, real driver)
docs/              configuration, deployment, security, commands, API, modules, troubleshooting
```

## Documentation

- [Configuration](docs/CONFIGURATION.md) — every environment variable
- [Commands](docs/COMMANDS.md) — all slash commands, options, and permissions
- [Modules](docs/MODULES.md) — the module system and each built-in module
- [API](docs/API.md) — REST API + dashboard, authentication model
- [Security](docs/SECURITY.md) — threat model and hardening choices
- [Deployment](docs/DEPLOYMENT.md) — Docker, compose, Discord app setup, production checklist
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common problems and fixes

## Status

Initial platform release (v0.1.0). Roadmap: tickets, verification, economy,
XP/levels, giveaways, polls, music, anti-raid tooling, and an automation rules engine.
