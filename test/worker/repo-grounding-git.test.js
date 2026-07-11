import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepoSnapshot } from '../../src/worker/repo-grounding.js';

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable())('collectRepoSnapshot against a real git repo', () => {
  let root;
  let baseCommit;

  const git = (...args) => execFileSync(
    'git',
    ['-C', root, '-c', 'user.email=test@kiroku.test', '-c', 'user.name=kiroku-test', ...args],
    { encoding: 'utf8' },
  ).trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'kiroku-grounding-'));
    git('init');
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'b.txt'), 'beta\n');
    git('add', '.');
    git('commit', '-m', 'base');
    baseCommit = git('rev-parse', 'HEAD');
    git('mv', 'a.txt', 'renamed.txt');
    git('commit', '-m', 'rename a.txt');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('detects renames since the base commit and missing candidates', () => {
    const snapshot = collectRepoSnapshot({
      rootPath: root,
      sinceCommit: baseCommit,
      candidatePaths: ['a.txt', 'sub/b.txt', 'ghost.txt'],
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.headCommit).not.toBe(baseCommit);
    expect(snapshot.renames).toContainEqual({ from: 'a.txt', to: 'renamed.txt' });
    expect(snapshot.missingPaths).toContain('ghost.txt');
    expect(snapshot.missingPaths).toContain('a.txt'); // rename wins in the planner
    expect(snapshot.missingPaths).not.toContain('sub/b.txt');
    expect(snapshot.refReset).toBe(false);
  });

  test('a stale base ref skips renames and flags the reset', () => {
    const snapshot = collectRepoSnapshot({
      rootPath: root,
      sinceCommit: '0123456789abcdef0123456789abcdef01234567',
      candidatePaths: [],
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.renames).toEqual([]);
    expect(snapshot.refReset).toBe(true);
  });

  test('a directory that is not a repo degrades to ok:false', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'kiroku-non-repo-'));
    try {
      const snapshot = collectRepoSnapshot({ rootPath: nonRepo, candidatePaths: ['x.txt'] });
      expect(snapshot.ok).toBe(false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
