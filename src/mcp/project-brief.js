import { createLogger } from '../shared/logger.js';

const log = createLogger('project-brief');

export function getProjectBrief(db, projectId, maxFacts) {
  const rows = db.prepare(`
    SELECT f.fact_type, f.predicate, f.object_text, f.heat, f.scope,
           f.object_detail, e.canonical_name as subject
    FROM facts f
    LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.status = 'active'
      AND ((f.project_id = ? AND f.scope = 'project') OR f.scope = 'global')
    ORDER BY
      CASE f.fact_type
        WHEN 'preference' THEN 0
        WHEN 'semantic'   THEN 1
        WHEN 'task'       THEN 2
        WHEN 'state'      THEN 3
        WHEN 'episodic'   THEN 4
        ELSE 5
      END,
      f.heat DESC
    LIMIT ?
  `).all(projectId, maxFacts);

  if (!rows.length) return 'No project context available yet.';

  const lines = rows.map(r => {
    const detail = r.object_detail ? ` — ${r.object_detail}` : '';
    const scope = r.scope === 'global' ? ' [global]' : '';
    return `[${r.fact_type}] ${r.subject || '?'} ${r.predicate} ${r.object_text}${detail}${scope}`;
  });

  return `# Project Memory Brief (${rows.length} facts)\n\n${lines.join('\n')}`;
}
