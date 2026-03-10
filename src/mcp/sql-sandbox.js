import { getDb } from '../shared/db.js';
import { SQL_DENY_PATTERNS, SQL_ALLOWED_PREFIXES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sql-sandbox');

export function sqlReadonly(params, sandboxConfig) {
  const db = getDb();
  const { sql, project_id } = params;
  const { maxRows = 200, maxCellBytes = 2048 } = sandboxConfig || {};

  const trimmed = sql.trim();
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
  if (!SQL_ALLOWED_PREFIXES.includes(firstWord)) {
    throw new Error(`Only ${SQL_ALLOWED_PREFIXES.join('/')} statements allowed. Got: ${firstWord}`);
  }

  const stripped = trimmed.replace(/'[^']*'/g, '""').replace(/"[^"]*"/g, '""');
  for (const pattern of SQL_DENY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(stripped)) {
      const m = stripped.match(re);
      throw new Error(`Forbidden SQL keyword: ${m ? m[0] : 'unknown'}`);
    }
  }

  let execSql = trimmed.replace(/;?\s*$/, '');
  if (!/\bLIMIT\b/i.test(execSql)) execSql += ` LIMIT ${maxRows}`;

  log.info({ sql: execSql.substring(0, 200) }, 'SQL query');
  const rows = db.prepare(execSql).all();
  const truncated = rows.length >= maxRows;

  if (rows.length === 0) return 'Query returned 0 rows.';

  const cols = Object.keys(rows[0]);
  let md = `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n`;
  for (const row of rows) {
    const cells = cols.map(c => {
      let v = row[c];
      if (v == null) return 'NULL';
      let s = String(v);
      if (s.length > maxCellBytes) s = s.substring(0, maxCellBytes - 3) + '...';
      return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    });
    md += `| ${cells.join(' | ')} |\n`;
  }

  return md + `\n_${rows.length} rows${truncated ? ' (truncated)' : ''}_`;
}
