#!/usr/bin/env node
// Offline key generation - DO NOT include in distribution packages
// Run: node scripts/gen-keypair.js

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const pubPath = join(__dirname, '..', 'keys', 'public.pem');
const privPath = join(__dirname, '..', 'keys', 'private.pem');

import { mkdirSync } from 'node:fs';
mkdirSync(join(__dirname, '..', 'keys'), { recursive: true });

writeFileSync(pubPath, publicKey);
writeFileSync(privPath, privateKey);

console.log('Generated Ed25519 keypair:');
console.log(`  Public:  ${pubPath}`);
console.log(`  Private: ${privPath}`);
console.log('\nCopy public.pem to ~/.kiroku/license/public.pem');
console.log('Keep private.pem SECURE and OFFLINE.');
