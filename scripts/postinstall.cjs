#!/usr/bin/env node
// postinstall: download pre-compiled .jsc bytecode from GitHub Releases
'use strict';

const https = require('node:https');
const http = require('node:http');
const { createGunzip } = require('node:zlib');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const EXPECTED_FILES = ['cli.jsc', 'proxy.jsc', 'worker.jsc', 'mcp.jsc'];
const SUPPORTED_NODE = ['20', '22', '24'];

const nodeMajor = process.versions.node.split('.')[0];
const version = require('../package.json').version;
const platform = process.platform;
const arch = process.arch;
const distDir = join(__dirname, '..', 'dist');

// Skip in dev / CI when .jsc already exists (built locally)
if (EXPECTED_FILES.every((f) => existsSync(join(distDir, f)))) {
  console.log('kiroku: .jsc files already present, skipping download.');
  process.exit(0);
}

// Skip if BUILD_JSC is set (local build will produce them)
if (process.env.BUILD_JSC === '1') {
  console.log('kiroku: BUILD_JSC=1, skipping postinstall download.');
  process.exit(0);
}

if (!SUPPORTED_NODE.includes(nodeMajor)) {
  console.error(
    `kiroku: unsupported Node.js version ${process.versions.node}. ` +
      `Supported: ${SUPPORTED_NODE.map((v) => `v${v}.x`).join(', ')}.`,
  );
  process.exit(1);
}

const baseUrl =
  process.env.KIROKU_JSC_URL ||
  `https://github.com/yelban/kiroku-public/releases/download/v${version}`;

// Try platform-specific first, then universal fallback
const urls = [
  `${baseUrl}/kiroku-v${version}-node${nodeMajor}-${platform}-${arch}.tar.gz`,
  `${baseUrl}/kiroku-v${version}-node${nodeMajor}.tar.gz`,
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto
      .get(url, { headers: { 'User-Agent': `kiroku-postinstall/${version}` } }, (res) => {
        // Follow redirects (GitHub sends 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

// Minimal tar extractor — only handles regular files, assumes short names
function extractTar(stream, destDir) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      let offset = 0;
      const extracted = [];

      while (offset + 512 <= buf.length) {
        // Read header
        const header = buf.subarray(offset, offset + 512);
        // Check for end-of-archive (two zero blocks)
        if (header.every((b) => b === 0)) break;

        const nameRaw = header.subarray(0, 100).toString('utf8');
        const name = nameRaw.replace(/\0.*$/, '').replace(/^\.\//, '');
        const sizeOctal = header.subarray(124, 136).toString('utf8').trim();
        const size = parseInt(sizeOctal, 8) || 0;
        const typeFlag = header[156];

        offset += 512; // skip header

        if (typeFlag === 48 || typeFlag === 0) {
          // regular file
          const basename = name.split('/').pop();
          if (basename && EXPECTED_FILES.includes(basename)) {
            const dest = join(destDir, basename);
            const data = buf.subarray(offset, offset + size);
            writeFileSync(dest, data);
            extracted.push(basename);
          }
        }

        // Advance past data blocks (512-byte aligned)
        offset += Math.ceil(size / 512) * 512;
      }

      resolve(extracted);
    });
  });
}

async function tryDownload(url) {
  console.log(`kiroku: downloading bytecode from ${url}`);
  const res = await fetch(url);
  const gunzip = createGunzip();
  res.pipe(gunzip);

  mkdirSync(distDir, { recursive: true });
  const extracted = await extractTar(gunzip, distDir);
  return extracted;
}

async function main() {
  let lastError;
  for (const url of urls) {
    try {
      const files = await tryDownload(url);
      const missing = EXPECTED_FILES.filter((f) => !files.includes(f));
      if (missing.length) {
        throw new Error(`Missing files in archive: ${missing.join(', ')}`);
      }
      console.log(`kiroku: bytecode installed successfully (Node ${nodeMajor}).`);
      return;
    } catch (err) {
      lastError = err;
      console.log(`kiroku: failed (${err.message}), trying next...`);
    }
  }

  console.error(`kiroku: could not download bytecode. Last error: ${lastError.message}`);
  console.error(
    'kiroku: set KIROKU_JSC_URL to override the download URL, ' +
      'or build from source with BUILD_JSC=1 node build.mjs',
  );
  process.exit(1);
}

main();
