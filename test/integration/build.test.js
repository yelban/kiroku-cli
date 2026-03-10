import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('esbuild bundle', () => {
  beforeAll(() => {
    execSync('node build.mjs', { cwd: ROOT, stdio: 'pipe' });
  });

  const bundles = ['dist/proxy.cjs', 'dist/worker.cjs', 'dist/mcp.cjs'];

  for (const bundle of bundles) {
    describe(bundle, () => {
      const fullPath = join(ROOT, bundle);

      it('exists', () => {
        expect(existsSync(fullPath)).toBe(true);
      });

      it('is non-empty', () => {
        const stat = statSync(fullPath);
        expect(stat.size).toBeGreaterThan(1000);
      });

      it('is valid JavaScript (no syntax errors)', () => {
        // Use Node's built-in syntax check
        expect(() => {
          execSync(`node -c "${fullPath}"`, { stdio: 'pipe' });
        }).not.toThrow();
      });

      it('does not contain source file paths', () => {
        const content = readFileSync(fullPath, 'utf8');
        // Should not leak full source paths
        expect(content).not.toContain('/Users/');
        expect(content).not.toContain('\\Users\\');
      });
    });
  }

  it('does not include extraction.md content in bundles', () => {
    const premiumPrompt = readFileSync(join(ROOT, 'prompts', 'extraction.md'), 'utf8');
    // Check that the full premium prompt is not embedded
    // (worker bundle may have basic prompt path reference, which is fine)
    for (const bundle of bundles) {
      const content = readFileSync(join(ROOT, bundle), 'utf8');
      // The full few-shot examples should NOT be in the bundle
      expect(content).not.toContain('alice@example.com');
    }
  });
});

describe('package.json files field', () => {
  it('includes dist/ but not src/', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('dist/*.cjs');
    expect(pkg.files).not.toContain('src/');
  });

  it('includes bundles and migrations', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('dist/*.cjs');
    expect(pkg.files).toContain('migrations/');
  });

  it('does not include prompts/', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).not.toContain('prompts/');
  });

  it('has build and prepublishOnly scripts', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBe('node build.mjs');
    expect(pkg.scripts.prepublishOnly).toBe('node build.mjs --obfuscate');
  });
});

describe('bin/kiroku.js USE_DIST logic', () => {
  it('resolves daemon scripts based on dist/src availability', () => {
    const bin = readFileSync(join(ROOT, 'bin', 'kiroku.js'), 'utf8');
    expect(bin).toContain('USE_DIST');
    expect(bin).toContain("dist', 'proxy.cjs'");
    expect(bin).toContain("dist', 'worker.cjs'");
    expect(bin).toContain("dist', 'mcp.cjs'");
  });

  it('sets KIROKU_ROOT env for spawned daemons', () => {
    const bin = readFileSync(join(ROOT, 'bin', 'kiroku.js'), 'utf8');
    expect(bin).toContain('KIROKU_ROOT: ROOT');
  });
});

describe('paths.js KIROKU_ROOT', () => {
  it('exports KIROKU_ROOT', () => {
    const paths = readFileSync(join(ROOT, 'src', 'shared', 'paths.js'), 'utf8');
    expect(paths).toContain('export const KIROKU_ROOT');
  });

  it('prioritizes process.env.KIROKU_ROOT', () => {
    const paths = readFileSync(join(ROOT, 'src', 'shared', 'paths.js'), 'utf8');
    expect(paths).toContain('process.env.KIROKU_ROOT');
  });
});
