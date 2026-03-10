-- 007_v12_enhancements.sql: v1.2 schema additions

-- 1a: Project activity tracking (for freeze)
ALTER TABLE projects ADD COLUMN last_active_at TEXT;
UPDATE projects SET last_active_at = updated_at WHERE last_active_at IS NULL;

-- 1b: Extended fact detail
ALTER TABLE facts ADD COLUMN object_detail TEXT;

-- 1c: Normalized entity name (for resolution)
ALTER TABLE entities ADD COLUMN normalized_name TEXT;
UPDATE entities SET normalized_name = REPLACE(REPLACE(REPLACE(LOWER(canonical_name), '_', ''), '-', ''), ' ', '');
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
