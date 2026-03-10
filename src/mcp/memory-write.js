import { getDb, isVecEnabled } from '../shared/db.js';
import { saveFactManually, archiveFacts, storeEmbeddings, setDb } from '../worker/store.js';
import { getLicenseState } from '../license/license-state.js';
import { createLogger } from '../shared/logger.js';
import { writeAudit } from '../shared/audit.js';

const log = createLogger('memory-write');

export async function memorySave(params) {
  setDb(getDb());
  const factType = params.fact_type || 'semantic';
  const scope = params.scope || (factType === 'preference' ? 'global' : 'project');
  const licenseState = await getLicenseState();
  const fid = saveFactManually({
    subject: params.subject,
    predicate: params.predicate,
    object: params.object,
    factType,
    projectId: params.project_id,
    scope,
    licenseState,
  });
  log.info({ factId: fid, subject: params.subject, scope }, 'fact saved');
  writeAudit(getDb(), { projectId: params.project_id, action: 'save', targetType: 'fact', targetId: fid, detail: { subject: params.subject, predicate: params.predicate, scope } });

  // Immediately embed so vector search can find it right away (skip if free tier)
  if (isVecEnabled() && licenseState.embeddingEnabled) {
    try {
      const { initEmbedder, embedTexts } = await import('../worker/embedder.js');
      const { loadConfig } = await import('../shared/config.js');
      await initEmbedder(loadConfig().worker.embedding);
      const text = `${params.subject} ${params.predicate} ${params.object}`;
      const embeddings = await embedTexts([text]);
      storeEmbeddings([fid], embeddings, params.project_id, [{ fact_type: factType, scope }]);
      log.info({ factId: fid }, 'embedding stored');
    } catch (err) {
      log.warn({ err: err.message }, 'embedding failed, fact saved without vector');
    }
  }

  return `Saved: ${params.subject} ${params.predicate} ${params.object} (scope: ${scope}, fact_id: ${fid})`;
}

export function memoryForget(params) {
  setDb(getDb());
  const archived = archiveFacts({
    factId: params.fact_id,
    subject: params.subject,
    predicate: params.predicate,
    projectId: params.project_id,
  });
  log.info({ count: archived.length }, 'facts archived');
  for (const aid of archived) {
    writeAudit(getDb(), { projectId: params.project_id, action: 'forget', targetType: 'fact', targetId: aid });
  }
  return archived.length > 0
    ? `Archived ${archived.length} facts: ${archived.join(', ')}`
    : 'No matching facts found to archive.';
}
