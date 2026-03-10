-- ADR-004: Rebuild fact_embeddings with scope column
-- vec0 does not support ALTER TABLE, must DROP + CREATE
-- Existing embeddings are lost. Run `kiroku reindex` to rebuild

DROP TABLE IF EXISTS fact_embeddings;

CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings USING vec0(
  fact_id TEXT PRIMARY KEY,
  project_id TEXT,
  scope TEXT,
  fact_type TEXT,
  status TEXT,
  embedding float[1024]
);
