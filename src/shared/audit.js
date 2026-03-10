import { nanoid } from 'nanoid';
import { createLogger } from './logger.js';

const log = createLogger('audit');

/**
 * Write an audit log entry. Non-blocking: failures are silently logged.
 * @param {import('better-sqlite3').Database} db
 * @param {{ projectId: string, action: string, targetType?: string, targetId?: string, detail?: object }} entry
 */
export function writeAudit(db, { projectId, action, targetType, targetId, detail }) {
  try {
    db.prepare(
      `INSERT INTO audit_logs (id, project_id, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `aud_${nanoid(16)}`,
      projectId,
      action,
      targetType || null,
      targetId || null,
      detail ? JSON.stringify(detail) : null,
    );
  } catch (err) {
    log.debug({ err: err.message, action }, 'audit write failed (non-fatal)');
  }
}
