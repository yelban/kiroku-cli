import { describe, it, expect } from 'vitest';
import { eventId, turnId, factId, entityId, jobId, convId } from '../../src/shared/ids.js';

describe('ids', () => {
  const cases = [
    { name: 'eventId', fn: eventId, prefix: 'evt_', totalLen: 4 + 16 },
    { name: 'turnId', fn: turnId, prefix: 'turn_', totalLen: 5 + 16 },
    { name: 'factId', fn: factId, prefix: 'fact_', totalLen: 5 + 16 },
    { name: 'entityId', fn: entityId, prefix: 'ent_', totalLen: 4 + 16 },
    { name: 'jobId', fn: jobId, prefix: 'job_', totalLen: 4 + 16 },
    { name: 'convId', fn: convId, prefix: 'conv_', totalLen: 5 + 16 },
  ];

  for (const { name, fn, prefix, totalLen } of cases) {
    describe(name, () => {
      it(`should start with "${prefix}"`, () => {
        expect(fn().startsWith(prefix)).toBe(true);
      });

      it(`should be ${totalLen} chars`, () => {
        expect(fn()).toHaveLength(totalLen);
      });

      it('should generate unique values', () => {
        const a = fn();
        const b = fn();
        expect(a).not.toBe(b);
      });
    });
  }
});
