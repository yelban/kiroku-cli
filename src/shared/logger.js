import pino from 'pino';
import { join } from 'node:path';
import { LOG_DIR, ensureDirs } from './paths.js';

export function createLogger(name) {
  ensureDirs();
  const logPath = join(LOG_DIR, `${name}.log`);
  return pino({
    name,
    level: process.env.KIROKU_LOG_LEVEL || 'info',
    transport: process.env.KIROKU_LOG_PRETTY === '1'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  }, process.env.KIROKU_LOG_PRETTY === '1'
      ? undefined
      : pino.destination({ dest: logPath, mkdir: true, sync: false }));
}
