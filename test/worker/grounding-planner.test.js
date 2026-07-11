import { describe, expect, test } from 'vitest';
import { planRepoGrounding, isRepoRelativePath } from '../../src/worker/grounding-planner.js';

const NOW = '2026-03-07T12:00:00.000Z';
const CONFIRM_MS = 6 * 3600_000;

function plan({ pathFacts, snapshot }) {
  return planRepoGrounding({ pathFacts, snapshot, now: NOW, confirmMs: CONFIRM_MS });
}

describe('planRepoGrounding', () => {
  test('rename wins over the missing flow for the same path', () => {
    const result = plan({
      pathFacts: [{ factId: 'f1', path: 'src/a.js', missingSince: null }],
      snapshot: {
        renames: [{ from: 'src/a.js', to: 'src/b.js' }],
        missingPaths: ['src/a.js'],
      },
    });
    expect(result.moves).toEqual([{ fromPath: 'src/a.js', toPath: 'src/b.js' }]);
    expect(result.markMissing).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test('one move per from-path even with several facts on it', () => {
    const result = plan({
      pathFacts: [
        { factId: 'f1', path: 'src/a.js', missingSince: null },
        { factId: 'f2', path: 'src/a.js', missingSince: null },
      ],
      snapshot: { renames: [{ from: 'src/a.js', to: 'src/b.js' }], missingPaths: [] },
    });
    expect(result.moves).toHaveLength(1);
  });

  test('first missing detection marks, does not archive', () => {
    const result = plan({
      pathFacts: [{ factId: 'f1', path: 'src/gone.js', missingSince: null }],
      snapshot: { renames: [], missingPaths: ['src/gone.js'] },
    });
    expect(result.markMissing).toEqual([{ factId: 'f1', path: 'src/gone.js' }]);
    expect(result.archive).toEqual([]);
  });

  test('archives only after the confirmation interval has elapsed', () => {
    const justMarked = plan({
      pathFacts: [{ factId: 'f1', path: 'src/gone.js', missingSince: '2026-03-07T08:00:00.000Z' }],
      snapshot: { renames: [], missingPaths: ['src/gone.js'] },
    });
    expect(justMarked.archive).toEqual([]);
    expect(justMarked.markMissing).toEqual([]);

    const confirmed = plan({
      pathFacts: [{ factId: 'f1', path: 'src/gone.js', missingSince: '2026-03-07T05:00:00.000Z' }],
      snapshot: { renames: [], missingPaths: ['src/gone.js'] },
    });
    expect(confirmed.archive).toEqual([{ factId: 'f1', path: 'src/gone.js' }]);
  });

  test('a path that came back clears its missing mark', () => {
    const result = plan({
      pathFacts: [{ factId: 'f1', path: 'src/back.js', missingSince: '2026-03-07T05:00:00.000Z' }],
      snapshot: { renames: [], missingPaths: [] },
    });
    expect(result.clearMissing).toEqual([{ factId: 'f1', path: 'src/back.js' }]);
    expect(result.archive).toEqual([]);
  });

  test('present unmarked paths produce no action', () => {
    const result = plan({
      pathFacts: [{ factId: 'f1', path: 'src/here.js', missingSince: null }],
      snapshot: { renames: [], missingPaths: [] },
    });
    expect(result).toEqual({ moves: [], markMissing: [], clearMissing: [], archive: [] });
  });
});

describe('isRepoRelativePath', () => {
  test.each([
    ['src/worker/store.js', true],
    ['README.md', true],
    ['docs/setup.md', true],
    ['/usr/local/bin/node', false],
    ['~/notes.md', false],
    ['https://example.com/a.js', false],
    ['PersistenceLayer', false],
    ['', false],
  ])('%s -> %s', (name, expected) => {
    expect(isRepoRelativePath(name)).toBe(expected);
  });
});
