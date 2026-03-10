#!/usr/bin/env node
// Offline license signing - DO NOT include in distribution packages
// Run: node scripts/sign-license.js <machine-id> [expiry-days]

import { readFileSync, writeFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mid = process.argv[2];
const tier = process.argv[3] || 'pro';
const expiryDays = parseInt(process.argv[4] || '365', 10);

if (!mid) {
  console.error('Usage: node scripts/sign-license.js <machine-id> [tier] [expiry-days]');
  console.error('  tier: free | pro | enterprise (default: pro)');
  process.exit(1);
}

const privPath = join(__dirname, '..', 'keys', 'private.pem');
const privateKey = readFileSync(privPath, 'utf8');

const payload = {
  mid,
  exp: Date.now() + expiryDays * 24 * 60 * 60 * 1000,
  tier,
  features: ['proxy', 'worker', 'mcp'],
  sig_v: 1,
};

const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
const signature = sign(null, Buffer.from(payloadB64), privateKey);
const licenseKey = `${payloadB64}.${signature.toString('hex')}`;

const outPath = join(__dirname, '..', 'keys', `license-${mid}.dat`);
writeFileSync(outPath, licenseKey);

console.log(`License generated for machine: ${mid}`);
console.log(`Expires: ${new Date(payload.exp).toISOString()}`);
console.log(`File: ${outPath}`);
console.log('\nCopy to ~/.kiroku/license/license.dat on the target machine.');
