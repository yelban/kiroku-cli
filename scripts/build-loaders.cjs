#!/usr/bin/env node
'use strict';
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const distDir = join(__dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });

const bundles = ['proxy', 'worker', 'mcp', 'cli'];

for (const name of bundles) {
  const isCli = name === 'cli';
  const loader = isCli
    ? `#!/usr/bin/env node\nrequire('bytenode');\nrequire('./${name}.jsc');\n`
    : `require('bytenode');\nrequire('./${name}.jsc');\n`;
  writeFileSync(join(distDir, `${name}.cjs`), loader);
  console.log(`  dist/${name}.cjs (loader stub)`);
}

console.log('Loader stubs generated. .jsc will be downloaded by postinstall.');
