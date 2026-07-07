import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { turnId, entityId, factId, jobId as makeJobId } from '../shared/ids.js';
import { isVecEnabled } from '../shared/db.js';
import { writeAudit } from '../shared/audit.js';
import { loadConfig } from '../shared/config.js';
import { normalizeSupersedeConfig, resolveSemanticSupersedes } from './supersede-resolver.js';

const log = createLogger('store');

function normalizeName(name) {
  return name.toLowerCase().replace(/[-_ ]/g, '');
}

let _db = null;

export function setDb(database) {
  _db = database;
}

export function storeTurn(event) {
  const d = _db;
  if (!d) throw new Error('DB not set');

  const projectId = event.project_id || 'default';
  const conversationId = event.conversation_id || 'unknown';

  // Ensure project exists
  d.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`).run(projectId, projectId);
  // Update last_active_at for decay freeze tracking
  d.prepare('UPDATE projects SET last_active_at = ?, updated_at = ? WHERE id = ?')
    .run(event.captured_at, event.captured_at, projectId);

  // Ensure conversation exists
  d.prepare(`INSERT OR IGNORE INTO conversations (id, project_id, auth_mode, system_hash, started_at) VALUES (?, ?, ?, ?, ?)`)
    .run(conversationId, projectId, event.auth_mode || 'unknown', event.request?.system_hash || null, event.captured_at);

  // Store user turn
  let userTurnId = null;
  const userText = event.request?.user_text || '';
  if (userText.trim()) {
    userTurnId = turnId();
    d.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, project_id, turn_index, role, text, text_sha256, model, stop_reason, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userTurnId, conversationId, projectId, event.turn_index * 2, 'user', userText,
        crypto.createHash('sha256').update(userText).digest('hex'), null, null, event.captured_at);
  }

  // Store assistant turn
  let assistantTurnId = null;
  const asstText = event.response?.assistant_text || '';
  if (asstText.trim()) {
    assistantTurnId = turnId();
    d.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, project_id, turn_index, role, text, text_sha256, model, stop_reason, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assistantTurnId, conversationId, projectId, event.turn_index * 2 + 1, 'assistant', asstText,
        crypto.createHash('sha256').update(asstText).digest('hex'),
        event.request?.model || null, event.response?.stop_reason || null,
        event.usage?.input_tokens || 0, event.usage?.output_tokens || 0,
        event.usage?.cache_read_input_tokens || 0, event.usage?.cache_creation_input_tokens || 0,
        event.captured_at);
  }

  return { userTurnId, assistantTurnId };
}

export function storeEntities(entities, projectId) {
  const d = _db;
  if (!d) throw new Error('DB not set');

  const now = new Date().toISOString();
  const entityMap = new Map(); // canonical_name -> entity_id

  for (const entity of entities) {
    const name = entity.canonical_name;
    if (!name) continue;

    // 1. Exact match by canonical_name
    let existing = d.prepare('SELECT id, aliases_json FROM entities WHERE canonical_name = ?').get(name);

    // 2. Normalized match fallback
    if (!existing) {
      const normalized = normalizeName(name);
      existing = d.prepare('SELECT id, canonical_name, aliases_json FROM entities WHERE normalized_name = ?').get(normalized);
      if (existing) {
        // Merge new name into aliases
        const aliases = JSON.parse(existing.aliases_json || '[]');
        if (!aliases.includes(name) && name !== existing.canonical_name) {
          aliases.push(name);
          d.prepare('UPDATE entities SET aliases_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(aliases), now, existing.id);
        }
      }
    }

    if (existing) {
      entityMap.set(name, existing.id);
      d.prepare('UPDATE entities SET last_seen_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, existing.id);
    } else {
      const id = entityId();
      const normalized = normalizeName(name);
      d.prepare('INSERT INTO entities (id, canonical_name, entity_type, aliases_json, normalized_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, entity.entity_type || 'concept', JSON.stringify(entity.aliases || []), normalized, now, now);
      entityMap.set(name, id);
    }
  }

  return entityMap;
}

export function storeFacts(facts, entityMap, projectId, sourceTurnId, licenseState) {
  const d = _db;
  if (!d) throw new Error('DB not set');

  const now = new Date().toISOString();
  const results = []; // aligned with input facts; null = deduped/skipped

  // Freemium eviction: enforce fact limit
  if (licenseState && !licenseState.licensed) {
    evictIfOverLimit(d, licenseState.factLimit, facts.length, now);
  }

  for (const fact of facts) {
    const subjectEntityId = entityMap.get(fact.subject) || null;
    const scope = fact.scope || (fact.fact_type === 'preference' ? 'global' : 'project');

    // Content-level dedup: skip if identical predicate+object+scope already exists
    const dupSql = scope === 'global'
      ? `SELECT id FROM facts WHERE predicate = ? AND object_text = ? AND scope = 'global' AND status = 'active' LIMIT 1`
      : `SELECT id FROM facts WHERE predicate = ? AND object_text = ? AND scope = ? AND status = 'active' AND project_id = ? LIMIT 1`;
    const dupParams = scope === 'global'
      ? [fact.predicate, fact.object]
      : [fact.predicate, fact.object, scope, projectId];
    const dup = d.prepare(dupSql).get(...dupParams);
    if (dup) {
      d.prepare(`UPDATE facts SET heat = MAX(heat, 0.7), updated_at = ? WHERE id = ?`).run(now, dup.id);
      log.debug({ dupId: dup.id, predicate: fact.predicate }, 'content dedup: boosted existing fact');
      results.push(null);
      continue;
    }

    // Check for existing active fact with same subject+predicate+scope → supersede
    if (subjectEntityId) {
      const existing = d.prepare(
        `SELECT id FROM facts WHERE project_id = ? AND subject_entity_id = ? AND predicate = ? AND scope = ? AND status = 'active'`
      ).get(projectId, subjectEntityId, fact.predicate, scope);

      if (existing) {
        d.prepare(`UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ?`).run(now, existing.id);
        if (isVecEnabled()) {
          try {
            d.prepare(`UPDATE fact_embeddings SET status = 'superseded' WHERE fact_id = ?`).run(existing.id);
          } catch { /* embedding may not exist yet */ }
        }
      }
    }

    const fid = factId();
    d.prepare(`INSERT INTO facts (id, project_id, subject_entity_id, predicate, object_text, object_detail, fact_type, confidence, heat, decay_bucket, source_turn_id, scope, status, base_heat, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fid, projectId, subjectEntityId, fact.predicate, fact.object, fact.detail || null,
        fact.fact_type || 'semantic', fact.confidence || 0.5, 0.7, 'hot', sourceTurnId, scope, 'active',
        0.7, now, 0);

    writeAudit(d, { projectId, action: 'extract', targetType: 'fact', targetId: fid, detail: { subject: fact.subject, predicate: fact.predicate } });
    results.push(fid);
  }

  return results;
}

export function storeEmbeddings(factIds, embeddings, projectId, facts, supersedeConfig) {
  if (!isVecEnabled()) {
    log.debug('vec not available, skipping embeddings');
    return;
  }

  const d = _db;
  if (!d) throw new Error('DB not set');

  const stmt = d.prepare(
    `INSERT INTO fact_embeddings (fact_id, project_id, scope, fact_type, status, embedding) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const inserted = [];

  for (let i = 0; i < factIds.length; i++) {
    if (i >= embeddings.length) break;
    const fact = facts[i] || {};
    const scope = fact.scope || (fact.fact_type === 'preference' ? 'global' : 'project');
    const embedding = new Float32Array(embeddings[i]);
    stmt.run(
      factIds[i],
      projectId,
      scope,
      fact.fact_type || 'semantic',
      'active',
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    );
    inserted.push({ factId: factIds[i], embedding });
  }

  runSemanticSupersedePass(d, inserted, projectId, supersedeConfig);
}

function runSemanticSupersedePass(d, insertedFacts, projectId, supersedeConfig) {
  if (insertedFacts.length === 0) return;

  const config = getSupersedeConfig(supersedeConfig);
  if (!config.enabled) return;

  const insertedIds = new Set(insertedFacts.map(item => item.factId));
  const now = new Date().toISOString();

  for (const inserted of insertedFacts) {
    const candidate = d.prepare(`
      SELECT
        f.id,
        f.subject_entity_id AS subjectEntityId,
        f.predicate,
        f.object_text AS objectText,
        f.fact_type AS factType,
        f.scope
      FROM facts f
      JOIN fact_embeddings fe ON fe.fact_id = f.id
      WHERE f.id = ? AND f.status = 'active' AND fe.status = 'active'
    `).get(inserted.factId);
    if (!candidate?.subjectEntityId) continue;

    const rows = selectSemanticSupersedeTargets(d, {
      projectId,
      scope: candidate.scope,
      subjectEntityId: candidate.subjectEntityId,
      factId: candidate.id,
    }).filter(row => !insertedIds.has(row.id));

    const activeFacts = rows.map(row => ({
      ...row,
      embedding: embeddingFromDb(row.embedding),
    }));
    const decisions = resolveSemanticSupersedes(
      { ...candidate, embedding: inserted.embedding },
      activeFacts,
      config,
    );

    for (const decision of decisions) {
      if (decision.action !== 'supersede' && decision.action !== 'archive') continue;

      const status = decision.action === 'archive' ? 'archived' : 'superseded';
      if (status === 'archived') {
        d.prepare(`UPDATE facts SET status = ?, decay_bucket = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`)
          .run(status, now, decision.targetFactId);
      } else {
        d.prepare(`UPDATE facts SET status = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
          .run(status, now, decision.targetFactId);
      }
      d.prepare(`UPDATE fact_embeddings SET status = ? WHERE fact_id = ?`).run(status, decision.targetFactId);
      writeAudit(d, {
        projectId,
        action: 'semantic_supersede',
        targetType: 'fact',
        targetId: decision.targetFactId,
        detail: {
          action: decision.action,
          sourceFactId: decision.sourceFactId,
          targetFactId: decision.targetFactId,
          cosine: roundCosine(decision.cosine),
          threshold: decision.threshold,
        },
      });
    }
  }
}

function getSupersedeConfig(supersedeConfig) {
  if (supersedeConfig) return normalizeSupersedeConfig(supersedeConfig);
  try {
    return normalizeSupersedeConfig(loadConfig().worker?.supersede);
  } catch {
    return normalizeSupersedeConfig();
  }
}

function selectSemanticSupersedeTargets(d, { projectId, scope, subjectEntityId, factId: currentFactId }) {
  const scopeClause = scope === 'global'
    ? `f.scope = 'global'`
    : `f.project_id = ? AND f.scope = ?`;
  const params = scope === 'global'
    ? [subjectEntityId, currentFactId]
    : [projectId, scope, subjectEntityId, currentFactId];

  return d.prepare(`
    SELECT
      f.id,
      f.subject_entity_id AS subjectEntityId,
      f.predicate,
      f.object_text AS objectText,
      f.fact_type AS factType,
      fe.embedding
    FROM facts f
    JOIN fact_embeddings fe ON fe.fact_id = f.id
    WHERE ${scopeClause}
      AND f.subject_entity_id = ?
      AND f.id != ?
      AND f.status = 'active'
      AND fe.status = 'active'
  `).all(...params);
}

function embeddingFromDb(value) {
  if (!value) return null;
  if (Array.isArray(value) || value instanceof Float32Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  return null;
}

function roundCosine(value) {
  return Number(value.toFixed(6));
}

export function createExtractionJob(jid, queueFile, eventId) {
  const d = _db;
  if (!d) return;
  d.prepare('INSERT INTO extraction_jobs (id, queue_file, queue_event_id) VALUES (?, ?, ?)').run(jid, queueFile, eventId);
}

export function updateExtractionJob(jid, updates) {
  const d = _db;
  if (!d) return;

  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase to snake_case
    fields.push(`${col} = ?`);
    values.push(val);
  }
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(jid);

  d.prepare(`UPDATE extraction_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// For manual saves from MCP gateway
export function saveFactManually({ subject, predicate, object, detail, factType, projectId, scope, licenseState }) {
  const d = _db;
  if (!d) throw new Error('DB not set');

  const resolvedScope = scope || (factType === 'preference' ? 'global' : 'project');
  const now = new Date().toISOString();

  // Freemium eviction
  if (licenseState && !licenseState.licensed) {
    evictIfOverLimit(d, licenseState.factLimit, 1, now);
  }

  // Ensure project exists
  d.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

  // Find or create entity (with normalized match fallback)
  let subjectEntityId;
  let existing = d.prepare('SELECT id, aliases_json FROM entities WHERE canonical_name = ?').get(subject);
  if (!existing) {
    const normalized = normalizeName(subject);
    existing = d.prepare('SELECT id, canonical_name, aliases_json FROM entities WHERE normalized_name = ?').get(normalized);
    if (existing) {
      const aliases = JSON.parse(existing.aliases_json || '[]');
      if (!aliases.includes(subject) && subject !== existing.canonical_name) {
        aliases.push(subject);
        d.prepare('UPDATE entities SET aliases_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(aliases), now, existing.id);
      }
    }
  }

  if (existing) {
    subjectEntityId = existing.id;
    d.prepare('UPDATE entities SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, subjectEntityId);
  } else {
    subjectEntityId = entityId();
    const normalized = normalizeName(subject);
    d.prepare('INSERT INTO entities (id, canonical_name, entity_type, aliases_json, normalized_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(subjectEntityId, subject, 'concept', '[]', normalized, now, now);
  }

  // Content-level dedup: return existing fact if identical predicate+object+scope
  const dupSql = resolvedScope === 'global'
    ? `SELECT id FROM facts WHERE predicate = ? AND object_text = ? AND scope = 'global' AND status = 'active' LIMIT 1`
    : `SELECT id FROM facts WHERE predicate = ? AND object_text = ? AND scope = ? AND status = 'active' AND project_id = ? LIMIT 1`;
  const dupParams = resolvedScope === 'global'
    ? [predicate, object]
    : [predicate, object, resolvedScope, projectId];
  const dup = d.prepare(dupSql).get(...dupParams);
  if (dup) {
    d.prepare(`UPDATE facts SET heat = MAX(heat, 0.7), updated_at = ? WHERE id = ?`).run(now, dup.id);
    return dup.id;
  }

  // Supersede existing (same scope only)
  const existingFact = d.prepare(
    `SELECT id FROM facts WHERE project_id = ? AND subject_entity_id = ? AND predicate = ? AND scope = ? AND status = 'active'`
  ).get(projectId, subjectEntityId, predicate, resolvedScope);
  if (existingFact) {
    d.prepare(`UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ?`).run(now, existingFact.id);
    if (isVecEnabled()) {
      try {
        d.prepare(`UPDATE fact_embeddings SET status = 'superseded' WHERE fact_id = ?`).run(existingFact.id);
      } catch { /* embedding may not exist yet */ }
    }
  }

  // Insert new fact
  const fid = factId();
  d.prepare(`INSERT INTO facts (id, project_id, subject_entity_id, predicate, object_text, object_detail, fact_type, confidence, heat, decay_bucket, source_turn_id, scope, status, base_heat, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fid, projectId, subjectEntityId, predicate, object, detail || null, factType || 'semantic', 1.0, 1.0, 'hot', null, resolvedScope, 'active',
      1.0, now, 0);

  return fid;
}

export function archiveFacts({ factId: fid, subject, predicate, projectId }) {
  const d = _db;
  if (!d) throw new Error('DB not set');

  const now = new Date().toISOString();
  const archived = [];

  if (fid) {
    d.prepare(`UPDATE facts SET status = 'archived', decay_bucket = 'archived', updated_at = ? WHERE id = ?`).run(now, fid);
    archived.push(fid);
  } else if (subject || predicate) {
    // Search both project-scoped and global facts
    let sql = `SELECT f.id FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id WHERE (f.project_id = ? OR f.scope = 'global') AND f.status = 'active'`;
    const params = [projectId];
    if (subject) { sql += ` AND e.canonical_name LIKE ?`; params.push(`%${subject}%`); }
    if (predicate) { sql += ` AND f.predicate LIKE ?`; params.push(`%${predicate}%`); }

    const rows = d.prepare(sql).all(...params);
    for (const row of rows) {
      d.prepare(`UPDATE facts SET status = 'archived', decay_bucket = 'archived', updated_at = ? WHERE id = ?`).run(now, row.id);
      archived.push(row.id);
    }
  }

  // Sync fact_embeddings status so vector search excludes archived facts
  if (archived.length > 0 && isVecEnabled()) {
    for (const id of archived) {
      try {
        d.prepare(`UPDATE fact_embeddings SET status = 'archived' WHERE fact_id = ?`).run(id);
      } catch { /* embedding may not exist */ }
    }
  }

  return archived;
}

function evictIfOverLimit(d, factLimit, incoming, now) {
  if (!factLimit || factLimit === Infinity) return;

  const activeCount = d.prepare("SELECT COUNT(*) as c FROM facts WHERE status = 'active'").get().c;
  const overflow = (activeCount + incoming) - factLimit;
  if (overflow <= 0) return;

  // Evict coldest facts: lowest heat, prefer cold/warm bucket, oldest first
  const victims = d.prepare(
    `SELECT id FROM facts WHERE status = 'active'
     ORDER BY heat ASC, CASE decay_bucket WHEN 'cold' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, created_at ASC
     LIMIT ?`
  ).all(overflow);

  for (const v of victims) {
    d.prepare(`UPDATE facts SET status = 'evicted', decay_bucket = 'evicted', updated_at = ? WHERE id = ?`).run(now, v.id);
    writeAudit(d, { projectId: 'system', action: 'evict', targetType: 'fact', targetId: v.id });
    if (isVecEnabled()) {
      try { d.prepare(`DELETE FROM fact_embeddings WHERE fact_id = ?`).run(v.id); } catch { /* ok */ }
    }
  }

  if (victims.length > 0) {
    log.info({ evicted: victims.length, limit: factLimit }, 'freemium fact eviction');
  }
}

export async function runDecaySweep(config, opts = {}) {
  const d = _db;
  if (!d) return;

  const decay = config.worker?.decay;
  if (!decay?.enabled) return;

  // Tunable: rows per inner transaction. Smaller chunks → shorter DB lock
  // window per chunk + more event-loop yields, but a bit more transaction
  // overhead. 5000 keeps each tx well under 1s on the 47k-fact dataset.
  const chunkSize = opts.chunkSize ?? 5000;

  const defaultHalfLife = decay.halfLifeHours || 168;
  const halfLifeByType = decay.halfLifeByType || {};
  const floorByType = decay.floorByType || {};
  const freezeDays = decay.freezeAfterInactiveDays ?? 7;
  const now = Date.now();

  // Build set of frozen projects
  const frozenProjects = new Set();
  if (freezeDays > 0) {
    const frozenRows = d.prepare(
      `SELECT id FROM projects WHERE last_active_at < datetime('now', '-' || ? || ' days')`
    ).all(freezeDays);
    for (const r of frozenRows) frozenProjects.add(r.id);
  }

  const rows = d.prepare(
    `SELECT id, base_heat, last_accessed_at, fact_type, project_id FROM facts WHERE status = 'active'`
  ).all();

  if (rows.length === 0) return;

  const updateStmt = d.prepare(
    `UPDATE facts SET heat = ?, decay_bucket = ?, updated_at = ? WHERE id = ?`
  );

  const isoNow = new Date(now).toISOString();
  let updated = 0;
  let skipped = 0;
  let chunks = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const tx = d.transaction(() => {
      for (const row of chunk) {
        // Skip frozen projects
        if (frozenProjects.has(row.project_id)) { skipped++; continue; }

        // Per-type half-life; null means never decay
        const halfLife = row.fact_type in halfLifeByType
          ? halfLifeByType[row.fact_type]
          : defaultHalfLife;
        if (halfLife === null) { skipped++; continue; }

        const floor = floorByType[row.fact_type] ?? 0;
        const lastAccessed = row.last_accessed_at ? new Date(row.last_accessed_at).getTime() : now;
        const elapsedHours = (now - lastAccessed) / 3600000;
        const newHeat = Math.max(floor, row.base_heat * Math.pow(0.5, elapsedHours / halfLife));
        const bucket = newHeat >= 0.7 ? 'hot' : newHeat >= 0.3 ? 'warm' : 'cold';
        updateStmt.run(newHeat, bucket, isoNow, row.id);
        updated++;
      }
    });
    tx();
    chunks++;
    // Yield event loop between chunks so MCP queries / pollQueue can run
    // mid-sweep instead of waiting for the entire 47k-fact set to commit.
    if (i + chunkSize < rows.length) {
      await new Promise(setImmediate);
    }
  }

  log.info({ updated, skipped, chunks, frozenProjects: frozenProjects.size }, 'decay sweep complete');
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized, so dot product = cosine
}

export async function runCompactionSweep(db, opts = {}, decayConfig = {}) {
  if (!isVecEnabled()) return { merged: 0, conflicts: 0 };

  const yieldEveryGroup = opts.yieldEvery ?? 1;       // yield between groups (default: every group)
  const yieldEveryEmb = opts.yieldEveryEmb ?? 50;     // yield mid-group during embedding loads
  const yieldEveryPair = opts.yieldEveryPair ?? 200;  // yield mid-group during O(N^2) cosine
  const floorByType = decayConfig?.floorByType || {};
  const tick = () => new Promise(setImmediate);

  const now = new Date().toISOString();
  let merged = 0;
  let conflicts = 0;
  let groupsProcessed = 0;

  // Group by subject_entity_id with >1 active fact
  const groups = db.prepare(`
    SELECT subject_entity_id, COUNT(*) as cnt
    FROM facts
    WHERE status = 'active' AND subject_entity_id IS NOT NULL
    GROUP BY subject_entity_id
    HAVING cnt > 1
  `).all();

  for (const { subject_entity_id } of groups) {
    if (++groupsProcessed % yieldEveryGroup === 0) {
      await tick();
    }
    const facts = db.prepare(`
      SELECT f.id, f.project_id, f.predicate, f.object_text, f.fact_type, f.heat, f.base_heat, f.created_at
      FROM facts f
      WHERE f.subject_entity_id = ? AND f.status = 'active'
      ORDER BY f.heat DESC
    `).all(subject_entity_id);

    // Load embeddings for this group (yield mid-stream for large groups)
    const embMap = new Map();
    let embIdx = 0;
    for (const f of facts) {
      try {
        const row = db.prepare(
          'SELECT embedding FROM fact_embeddings WHERE fact_id = ? AND status = ?'
        ).get(f.id, 'active');
        if (row) embMap.set(f.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
      } catch { /* embedding may not exist */ }
      if (++embIdx % yieldEveryEmb === 0) await tick();
    }

    // Greedy merge: anchor = highest heat, cosine > 0.92 = merge
    const archived = new Set();
    let pairIdx = 0;
    for (let i = 0; i < facts.length; i++) {
      if (archived.has(facts[i].id)) continue;
      const embA = embMap.get(facts[i].id);
      if (!embA) continue;

      for (let j = i + 1; j < facts.length; j++) {
        if (archived.has(facts[j].id)) continue;
        const embB = embMap.get(facts[j].id);
        if (!embB) continue;

        if (++pairIdx % yieldEveryPair === 0) await tick();

        const cosine = cosineSimilarity(embA, embB);

        if (cosine > 0.92) {
          // Archive lower-heat fact, boost survivor
          db.prepare(`UPDATE facts SET status = 'compacted', updated_at = ? WHERE id = ?`)
            .run(now, facts[j].id);
          db.prepare(`UPDATE fact_embeddings SET status = 'compacted' WHERE fact_id = ?`)
            .run(facts[j].id);
          db.prepare(`UPDATE facts SET heat = MAX(heat, ?), base_heat = MAX(base_heat, ?), updated_at = ? WHERE id = ?`)
            .run(facts[j].heat, facts[j].base_heat, now, facts[i].id);
          archived.add(facts[j].id);
          merged++;
        } else if (cosine > 0.75) {
          // Phase 3: Conflict detection — related but not duplicate
          if (facts[i].predicate === facts[j].predicate &&
              facts[i].object_text !== facts[j].object_text) {
            log.warn({
              factA: facts[i].id, factB: facts[j].id,
              predicate: facts[i].predicate,
              objectA: facts[i].object_text, objectB: facts[j].object_text,
              cosine: cosine.toFixed(3),
            }, 'potential fact conflict detected');
            demoteConflictFacts(db, facts[i], facts[j], cosine, floorByType, now);
            conflicts++;
          }
        }
      }
    }
  }

  log.info({ merged, conflicts }, 'compaction sweep complete');
  return { merged, conflicts };
}

function demoteConflictFacts(db, factA, factB, cosine, floorByType, now) {
  const tx = db.transaction(() => {
    demoteConflictFact(db, factA, factB, cosine, floorByType, now);
    demoteConflictFact(db, factB, factA, cosine, floorByType, now);
  });
  tx();
}

function demoteConflictFact(db, fact, conflictingFact, cosine, floorByType, now) {
  const current = db.prepare(`
    SELECT id, project_id, predicate, object_text, fact_type, heat, base_heat
    FROM facts
    WHERE id = ? AND status = 'active'
  `).get(fact.id);
  if (!current) return;

  const floor = floorByType[current.fact_type] ?? 0;
  const heatAfter = Math.max(floor, current.heat * 0.5);
  const baseHeatAfter = Math.max(floor, current.base_heat * 0.5);

  db.prepare(`
    UPDATE facts
    SET heat = ?, base_heat = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(heatAfter, baseHeatAfter, now, current.id);

  fact.heat = heatAfter;
  fact.base_heat = baseHeatAfter;

  writeAudit(db, {
    projectId: current.project_id,
    action: 'conflict_demote',
    targetType: 'fact',
    targetId: current.id,
    detail: {
      cosine: roundCosine(cosine),
      conflictingFactId: conflictingFact.id,
      predicate: current.predicate,
      object: current.object_text,
      conflictingObject: conflictingFact.object_text,
      heatBefore: current.heat,
      heatAfter,
      baseHeatBefore: current.base_heat,
      baseHeatAfter,
      floor,
    },
  });
}

export function boostFactHeat(factIds, boost = 0.05) {
  const d = _db;
  if (!d || !factIds?.length) return;

  const now = new Date().toISOString();
  const stmt = d.prepare(
    `UPDATE facts SET last_accessed_at = ?, access_count = access_count + 1, base_heat = MIN(base_heat + ?, 1.0), updated_at = ? WHERE id = ? AND status = 'active'`
  );

  const tx = d.transaction(() => {
    for (const fid of factIds) {
      stmt.run(now, boost, now, fid);
    }
  });

  tx();
}
