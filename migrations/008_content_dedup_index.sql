CREATE INDEX IF NOT EXISTS idx_facts_content_dedup
ON facts(predicate, object_text, scope, status);
