import { getSystemHealth } from '../shared/health.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('health-status');

export async function healthStatus(config) {
  const health = await getSystemHealth(config);

  const lines = [`System: ${health.status.toUpperCase()}`];

  const db = health.components.database;
  if (db.status === 'ok') {
    lines.push(`DB: ${db.projects} projects, ${db.facts} facts, ${db.entities} entities, ${db.turns} turns`);
  } else {
    lines.push(`DB: ${db.status}${db.error ? ' — ' + db.error : ''}`);
  }

  const q = health.components.queue;
  lines.push(`Queue: ${q.incoming} incoming, ${q.processing} processing, ${q.dead_letter} dead-letter`);

  const emb = health.components.embedding_model;
  lines.push(`Embedding: ${emb.cached ? 'cached' : 'not cached'}, coverage ${emb.coverage_percent}%`);

  const key = health.components.extraction_key;
  lines.push(`Extraction key (${key.env_var}): ${key.set ? 'set' : 'NOT SET'}`);

  const lic = health.components.license;
  lines.push(`License: ${lic.licensed ? `${lic.tier} (expires ${lic.expiry || 'N/A'})` : `free tier`}`);

  if (health.issues.length > 0) {
    lines.push('', 'Issues:', ...health.issues.map(i => `  - ${i}`));
  }

  return lines.join('\n');
}
