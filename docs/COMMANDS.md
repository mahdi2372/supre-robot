# Slash Commands

All commands are guild-only. The required permission is enforced by the bot
(the command is rejected with a localized error if you lack it) **and** mirrors
the permission set on the command definition in Discord.

Commands appear as soon as the bot registers them at startup. With
`DISCORD_GUILD_ID` set, registration is instant in that guild; globally it can
take up to an hour (Discord's cache).

## Core

| Command | Description | Permission |
| --- | --- | --- |
| `/ping` | Check bot and gateway latency | none |
| `/about` | About Supre Robot (version, uptime, stats) | none |
| `/lang set locale:<EN\|BN>` | Set the guild's default language for bot messages | ManageGuild |
| `/status` | Admin control center: bot, database, modules, errors, security (24h), server stats | ManageGuild |

## Moderation

| Command | Description | Permission |
| --- | --- | --- |
| `/warn user reason [note] [evidence]` | Warn a member; notes + evidence are stored; triggers the escalation ladder | ModerateMembers |
| `/warnings user` | Show a member's active warnings in the current window | ModerateMembers |
| `/ban user reason [delete-days] [temp-hours]` | Ban a member (temp bans via `temp-hours`, max 672h = 28 days) | BanMembers |
| `/unban user reason` | Unban a user by ID or tag | BanMembers |
| `/kick user reason` | Kick a member | KickMembers |
| `/timeout user [reason] [minutes]` | Timeout a member (max 28 days); omit `minutes` to clear an existing timeout | ModerateMembers |
| `/softban user reason` | Ban and immediately unban — deletes the last 24h of the user's messages | BanMembers |
| `/clear count [user]` | Bulk-delete up to 100 messages, optionally only from one user | ManageChannels |
| `/slowmode channel seconds` | Set slow mode (0–21600s) | ManageChannels |
| `/lock channel` | Remove Send Messages from @everyone | ManageChannels |
| `/unlock channel` | Restore Send Messages for @everyone | ManageChannels |
| `/case number` | Look up a moderation case by its guild number | ModerateMembers |

**Case numbers** are allocated atomically per guild and never reused. Every
punishment (warn/ban/kick/timeout/softban) writes a case and an audit log entry;
temporary punishments create an expiry job that auto-reverts on time.

**Escalation ladder** (moderation settings): after N active warnings, the next
warning automatically applies the configured action (e.g. timeout → kick → ban).

## Auto-moderation

| Command | Description | Permission |
| --- | --- | --- |
| `/automod [test <sample>]` | Without `test`: show the current rule summary. With `test`: dry-run a sample message against all detectors and show the verdict + signals — no message is touched | ManageGuild |

Detectors: caps, emoji ratio, mention spam, Discord invites, suspicious/shortener
URLs, banned words (whole-word, case-insensitive, zero-width-character resistant),
custom regex patterns, message flood, duplicate spam, and a weak "new account"
signal. Weak signals can **never** trigger a punishment alone.

## Welcome / leave

| Command | Description | Permission |
| --- | --- | --- |
| `/welcome [channel] [title] [message]` | Set the welcome channel, join embed title, and join description. At least one option required | ManageGuild |

Template variables (double braces): `{{user}}` (mention), `{{user_name}}`,
`{{guild}}`, `{{count}}`, `{{account_age}}`.

## Custom commands

| Command | Description | Permission |
| --- | --- | --- |
| `/customcreate name response [cooldown] [role] [permission] [args-mode]` | Create a custom command. `response` uses the safe template engine: `{{user}}` `{{user_name}}` `{{guild}}` `{{channel}}` `{{args}}` | ManageGuild |
| `/customlist` | List this server's custom commands | ManageGuild |
| `/customdelete name` | Delete a custom command | ManageGuild |
| `/customtoggle name enabled` | Enable/disable a custom command | ManageGuild |

Custom commands are registered as real Discord slash commands per guild and are
restricted by optional role, Discord permission, and per-user cooldown.
Templates cannot execute code: only `{{name}}` / `{{a.b}}` variable lookups are
supported — no loops, conditionals, or function access.

## Configuration

| Command | Description | Permission |
| --- | --- | --- |
| `/config module action:<list\|view\|enable\|disable> [module]` | List modules, view one module's settings, enable, or disable a module | ManageGuild |
| `/config channel module:<logging\|welcome\|moderation> [channel]` | Set (or clear, by omitting `channel`) a module's log channel | ManageGuild |
| `/config list` | List all modules and their status | ManageGuild |

Modules: `core`, `logging`, `welcome`, `moderation`, `automod`, `custom`.
`core` cannot be disabled. Modules are enabled by default in a fresh server.
