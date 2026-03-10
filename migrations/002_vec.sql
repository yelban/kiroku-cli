CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings USING vec0(
  fact_id TEXT PRIMARY KEY,
  project_id TEXT,
  fact_type TEXT,
  status TEXT,
  embedding float[1024]
);
