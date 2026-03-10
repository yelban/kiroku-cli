import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_INCOMING } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('queue-writer');

export function writeQueueEvent(event) {
  try {
    const filename = `${event.event_id}.jsonl`;
    const tmpPath = join(QUEUE_INCOMING, `.${filename}.tmp`);
    const finalPath = join(QUEUE_INCOMING, filename);

    const line = JSON.stringify(event) + '\n';
    writeFileSync(tmpPath, line, 'utf8');
    renameSync(tmpPath, finalPath);

    log.debug({ eventId: event.event_id }, 'queue event written');
  } catch (err) {
    log.error({ err: err.message, eventId: event.event_id }, 'failed to write queue event');
  }
}
