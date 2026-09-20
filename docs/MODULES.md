# Modules

Supre Robot is a modular platform: every feature is a `SupreModule` that the
`ModuleManager` boots, isolates, and reports on. Modules declare a name,
version, description, optional dependencies, an `onReady` hook, event handlers,
and a list of slash commands.

## The `SupreModule` contract

A module provides:

- **`name` / `version` / `description`** — identity, surfaced in `/status`, the
  dashboard, and API responses.
- **`dependsOn`** — module names this one needs; the manager topologically
  sorts boot order and boots dependents first.
- **`settings`** (optional) — a zod schema + defaults for guild-level settings.
  Registered with the central `SettingsService`; every read is validated, so a
  corrupted DB row can never reach module code.
- **`onReady(ctx)`** — async startup hook (registering Discord event handlers,
  warming caches).
- **`commands`** — slash commands (see below).
- **Optional event handlers** — e.g. `messageCreate`, `guildMemberAdd`.

A module that throws during boot or in a handler is **isolated**: it is marked
`error` in the status snapshot and the rest of the bot keeps running.

## `ModuleContext` — what modules get

| Field | Description |
| --- | --- |
| `client` | The discord.js `Client`. |
| `config` | Validated `AppConfig`. |
| `db` | `QueryExecutor` — `query()` and `transaction()` (auto commit/rollback). |
| `cache` | `CacheStore` (Redis or in-memory). |
| `logger` | Structured pino logger (secrets redacted). |
| `settings` | `SettingsService` — validated, cached guild settings. |
| `logs` | `LogService` — sanitized, persisted audit logging. |
| `jobs` | `JobScheduler` — durable scheduled tasks. |
| `metrics` | `Metrics` — counters for commands and errors. |
| `ui` | `UiRegistry` — register interactive components. |
| `t` | i18n translate function (en, bn). |
| `moduleSnapshot` | Live `{status, version}` of all modules. |

## `SupreCommand` contract

Each command declares `module`, `name`, `description`, `configure(builder)`
(options and/or subcommands), and `run(ctx, interaction)`. It may also set:

- **`requiredPermission`** — a Discord permission flag name the invoker must
  have. Enforced **server-side, always** (never trusted from the client).
- **`requiredRoleId`** — optional role the invoker must hold.
- **`cooldownSeconds`** — per user per guild.

Commands are routed centrally: built-in slash commands, then custom (DB-backed)
commands, then module commands. Interaction errors reply with a localized,
user-safe message (never a stack trace).

## Built-in modules

| Module | Purpose |
| --- | --- |
| `core` | Ping, about, control center (`/status`), language. Always on; cannot be disabled. |
| `logging` | Records Discord events (joins, leaves, bans, message/channel/role updates) to the audit log. |
| `welcome` | Welcome/leave embeds, optional DM, optional auto-roles gated by minimum account age. |
| `moderation` | Punishments with atomic case numbers, escalation ladder, expiry jobs, and the `/case` lookup. |
| `automod` | Message scanning with pluggable detectors + a false-positive-protecting decision policy. |
| `config` | `/config` — list/view/enable/disable modules and set log channels. |
| `custom` | DB-backed custom commands registered as real slash commands per guild. |

## Per-guild enablement & settings

- Every module (except `core`) can be enabled/disabled per guild via
  `/config module` or the dashboard. Modules are **enabled by default** in a
  fresh server.
- Guild settings are stored as JSONB in `guild_settings`, merged over the
  module's defaults, and **always validated by the module's zod schema** before
  use.
- Reads are cached (60s TTL) and invalidated on write. If the DB is briefly
  down, `isEnabled` degrades to `true` (fresh-server behavior) rather than taking
  the whole bot down.

## Adding a module

1. Create `src/modules/<name>/` with a module file exporting a `SupreModule`.
2. Define a zod settings schema + defaults (if the module is configurable).
3. Add it to `ALL_MODULES` in `src/modules/index.ts`.
4. Register its settings schema in the startup wiring (see `src/index.ts`).
5. Add tests + docs.

The manager handles dependency ordering, failure isolation, and status
reporting — a new module needs no changes to the core.
