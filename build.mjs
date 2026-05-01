#!/usr/bin/env node
import { build } from 'esbuild';
import { rmSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

// Clean dist/
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  loader: {
    '.md': 'text',
  },
  external: [
    'better-sqlite3',
    'sqlite-vec',
    '@huggingface/transformers',
    '@modelcontextprotocol/sdk',
    'pino',
    'pino-pretty',
  ],
};

const bundles = [
  { entry: 'src/proxy/server.js', name: 'proxy' },
  { entry: 'src/worker/worker.js', name: 'worker' },
  { entry: 'src/mcp/server.js', name: 'mcp' },
  { entry: 'bin/kiroku.js', name: 'cli' },
];

// ---------------------------------------------------------------------------
// Stage 1: esbuild → dist/*.raw.cjs
// ---------------------------------------------------------------------------
console.log('Stage 1: esbuild → CJS bundles');
for (const { entry, name } of bundles) {
  await build({ ...shared, entryPoints: [entry], outfile: `dist/${name}.raw.cjs` });
  console.log(`  ${entry} → dist/${name}.raw.cjs`);
}

// ---------------------------------------------------------------------------
// Check if full protection build is requested (--jsc flag or BUILD_JSC env)
// Without it, just produce plain .cjs (same as before) for dev convenience
// ---------------------------------------------------------------------------
const doProd =
  process.argv.includes('--obfuscate') ||
  process.argv.includes('--jsc') ||
  process.env.BUILD_JSC === '1';

if (!doProd) {
  // Dev mode: rename .raw.cjs → .cjs (same as original build)
  for (const { name } of bundles) {
    const raw = `dist/${name}.raw.cjs`;
    const out = `dist/${name}.cjs`;
    writeFileSync(out, readFileSync(raw));
    unlinkSync(raw);
  }
  console.log('Build complete (dev mode, no bytecode).');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Stage 2: Patch dynamic imports
// ---------------------------------------------------------------------------
console.log('Stage 2: Patch dynamic imports');

function patchDynamicImports(code) {
  // Strip shebang — it breaks the obfuscator parser
  const stripped = code.replace(/^#!.*\n/, '');
  const shim =
    'var __import=function(m){var r=require(m);' +
    'return Promise.resolve(r&&r.__esModule?r:' +
    'Object.assign({default:r},typeof r==="object"&&r!==null?r:{}))};';
  return shim + stripped.replace(/\bimport\s*\(/g, '__import(');
}

for (const { name } of bundles) {
  const raw = `dist/${name}.raw.cjs`;
  const code = readFileSync(raw, 'utf8');
  writeFileSync(raw, patchDynamicImports(code));
  console.log(`  patched dist/${name}.raw.cjs`);
}

// ---------------------------------------------------------------------------
// Stage 3: javascript-obfuscator
// ---------------------------------------------------------------------------
console.log('Stage 3: javascript-obfuscator');
const JavaScriptObfuscator = (await import('javascript-obfuscator')).default;

for (const { name } of bundles) {
  const raw = `dist/${name}.raw.cjs`;
  const obf = `dist/${name}.obf.cjs`;
  const code = readFileSync(raw, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    stringArray: true,
    stringArrayThreshold: 1.0,
    stringArrayEncoding: ['base64'],
    rotateStringArray: true,
    identifierNamesGenerator: 'hexadecimal',
    selfDefending: false,
    controlFlowFlattening: false,
  });
  writeFileSync(obf, result.getObfuscatedCode());
  console.log(`  dist/${name}.raw.cjs → dist/${name}.obf.cjs`);
}

// ---------------------------------------------------------------------------
// Stage 4: Finalize → dist/*.cjs (obfuscated)
// ---------------------------------------------------------------------------
console.log('Stage 4: Finalize');

for (const { name } of bundles) {
  const obf = `dist/${name}.obf.cjs`;
  const out = `dist/${name}.cjs`;
  let code = readFileSync(obf, 'utf8');
  if (name === 'cli') {
    code = '#!/usr/bin/env node\n' + code;
  }
  writeFileSync(out, code);
  console.log(`  dist/${name}.obf.cjs → dist/${name}.cjs`);
}

// ---------------------------------------------------------------------------
// Cleanup: remove intermediate files
// ---------------------------------------------------------------------------
console.log('Cleanup: removing intermediate files');
for (const { name } of bundles) {
  unlinkSync(`dist/${name}.raw.cjs`);
  unlinkSync(`dist/${name}.obf.cjs`);
}

console.log('Build complete (obfuscated source protection).');
