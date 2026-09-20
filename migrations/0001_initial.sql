-- 0001_initial — core schema
-- Additive-only. Never modify this file after it has been applied.

CREATE TABLE IF NOT EXISTS servers (
  guild_id      TEXT PRIMARY KEY,
  name          TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  case_counter  INTEGER NOT NULL DEFAULT 0,
  ticket_counter INTEGER NOT NULL DEFAULT 0,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-guild, per-module configuration. module_key 'core' holds global
-- guild-level settings (locale, etc.). enabled=false disables the module.
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL DEFAULT 'core',
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_guild_settings_module ON guild_settings (module_key);

CREATE TABLE IF NOT EXISTS users (
  discord_id  TEXT PRIMARY KEY,
  username    TEXT,
  avatar      TEXT,
  locale      TEXT NOT NULL DEFAULT 'en',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  guild_id     TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (discord_id) ON DELETE CASCADE,
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ,
  xp           BIGINT NOT NULL DEFAULT 0,
  level        INTEGER NOT NULL DEFAULT 1,
  last_xp_at   TIMESTAMPTZ,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_guild_xp ON members (guild_id, xp DESC);

-- Roles managed by the bot (auto roles, verification roles, temporary roles).
CREATE TABLE IF NOT EXISTS managed_roles (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL,
  module      TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, role_id, module, purpose)
);
CREATE INDEX IF NOT EXISTS idx_managed_roles_guild ON managed_roles (guild_id);

CREATE TABLE IF NOT EXISTS warnings (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  case_id     INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  note        TEXT,
  evidence    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_cases (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  case_number  INTEGER NOT NULL,
  type         TEXT NOT NULL,           -- warn|ban|kick|timeout|softban|automod
  target_id    TEXT NOT NULL,
  moderator_id TEXT,                    -- NULL when automated
  reason       TEXT NOT NULL DEFAULT '',
  note         TEXT,
  evidence     TEXT,
  expires_at   TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'active',  -- active|expired|reversed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_guild ON moderation_cases (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_target ON moderation_cases (guild_id, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_expires ON moderation_cases (status, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS tickets (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  category     TEXT NOT NULL DEFAULT 'general',
  channel_id   TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  assigned_to  TEXT,
  status       TEXT NOT NULL DEFAULT 'open',   -- open|closed
  close_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,
  UNIQUE (guild_id, number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets (guild_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  BIGINT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  author_id  TEXT,
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, id);

CREATE TABLE IF NOT EXISTS giveaways (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  host_id       TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  winners_count INTEGER NOT NULL DEFAULT 1,
  required_role_id TEXT,
  min_account_age_ms BIGINT,
  min_guild_age_ms   BIGINT,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active|ended|cancelled
  seed          TEXT,                            -- hex seed used for winner selection
  winner_ids    TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways (status, ends_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS polls (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  creator_id  TEXT NOT NULL,
  question    TEXT NOT NULL,
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  anonymous   BOOLEAN NOT NULL DEFAULT FALSE,
  multi       BOOLEAN NOT NULL DEFAULT FALSE,
  ends_at     TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open',   -- open|closed
  message_id  TEXT,
  votes       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- optionIndex -> userIds
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_guild ON polls (guild_id, status);

CREATE TABLE IF NOT EXISTS economy_accounts (
  guild_id     TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  balance      BIGINT NOT NULL DEFAULT 0,
  last_daily_at  TIMESTAMPTZ,
  last_weekly_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_economy_balance ON economy_accounts (guild_id, balance DESC);

-- Double-entry style ledger. idempotency_key prevents duplicate transactions.
CREATE TABLE IF NOT EXISTS transactions (
  id             BIGSERIAL PRIMARY KEY,
  guild_id       TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,       -- earn|spend|transfer_in|transfer_out|admin_adjust|reward
  amount         BIGINT NOT NULL,     -- signed
  balance_after  BIGINT NOT NULL,
  idempotency_key TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automod_rules (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,        -- banned_words|regex|url
  pattern       TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'delete',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automod_rules ON automod_rules (guild_id, enabled);

CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- join_spike|mass_ban|lockdown|automod_action|...
  severity    TEXT NOT NULL DEFAULT 'info',  -- info|warning|critical
  actor_id    TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events ON security_events (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_logs (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- see LogKind in src/services/logService.ts
  actor_id    TEXT,
  target_id   TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_logs_guild ON bot_logs (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_logs_kind ON bot_logs (guild_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS custom_commands (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  response          TEXT NOT NULL,
  required_role_id  TEXT,
  required_permission TEXT,
  channel_ids       TEXT[] NOT NULL DEFAULT '{}',
  cooldown_ms       INTEGER NOT NULL DEFAULT 0,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  event       TEXT NOT NULL,          -- member_join|warning_threshold|message_sent|...
  conditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  priority    INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_rules ON automation_rules (guild_id, event, enabled);

CREATE TABLE IF NOT EXISTS jobs (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  guild_id    TEXT REFERENCES servers (guild_id) ON DELETE CASCADE,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  runs_at     TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  recurring_ms BIGINT,
  last_run_at TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, type)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, runs_at);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash  TEXT PRIMARY KEY,
  discord_id  TEXT NOT NULL,
  username    TEXT,
  avatar      TEXT,
  guilds      JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at  TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON dashboard_sessions (expires_at);
