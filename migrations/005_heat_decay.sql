-- Heat/Decay system: add access tracking and base_heat columns

ALTER TABLE facts ADD COLUMN last_accessed_at TEXT;
ALTER TABLE facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facts ADD COLUMN base_heat REAL NOT NULL DEFAULT 0.5;

-- Backfill: set last_accessed_at to created_at for existing facts
UPDATE facts SET last_accessed_at = created_at WHERE last_accessed_at IS NULL;

-- Backfill: manual facts (no source_turn_id, heat=1.0) get base_heat=1.0
UPDATE facts SET base_heat = 1.0 WHERE source_turn_id IS NULL AND heat = 1.0;

-- Backfill: active extracted facts get base_heat=0.7
UPDATE facts SET base_heat = 0.7 WHERE base_heat = 0.5 AND status = 'active';

-- Index for decay sweep (find active facts efficiently)
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(status, last_accessed_at);
