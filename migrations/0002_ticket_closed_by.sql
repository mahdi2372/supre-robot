-- 0002: tickets — atomic ticket numbering, closer attribution, fast lookups.
-- Additive only: no existing column or table is modified or dropped.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by TEXT;

-- Atomic per-guild ticket number allocation (UPDATE ... RETURNING), the same
-- pattern as moderation's case_counter.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS ticket_counter INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (guild_id, channel_id, status);
