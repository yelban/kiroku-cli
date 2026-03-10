-- ADR-004: Add scope column to facts table
ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';

-- Existing preferences are cross-project by nature
UPDATE facts SET scope = 'global' WHERE fact_type = 'preference';

CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
CREATE INDEX IF NOT EXISTS idx_facts_project_scope ON facts(project_id, scope, status);
