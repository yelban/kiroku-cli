import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { KIROKU_ROOT, PROMPT_CACHE_PATH, PROMPT_CACHE_DIR, LICENSE_KEY_PATH } from '../shared/paths.js';
import { getMachineId } from '../license/machine-id.js';
import { deriveKey, encrypt, decrypt } from './prompt-crypto.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('prompt-loader');

const PROMPT_API_URL = 'https://kiroku-api.twampd.workers.dev/prompt';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24h

let _cachedPrompt = null;
let _cachedEtag = null;
let _refreshTimer = null;

// Embedded basic prompt (free tier fallback)
function getBasicPrompt() {
  const basicPath = join(KIROKU_ROOT, 'prompts', 'extraction-basic.md');
  if (existsSync(basicPath)) {
    return readFileSync(basicPath, 'utf8');
  }
  // Absolute fallback if file missing
  return 'You are a knowledge extraction engine. Extract entities and facts as JSON. Respond with ONLY JSON.';
}

function getLicenseKey() {
  if (!existsSync(LICENSE_KEY_PATH)) return null;
  try {
    return readFileSync(LICENSE_KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

// Layer 1: Memory cache
export function getPrompt() {
  return _cachedPrompt || getBasicPrompt();
}

// Batch prompt accessor — placeholder for a future prompt-server endpoint
// that serves slot-keyed prompts. Currently the server only ships the
// default extraction prompt, so we return null to let the caller
// (extractor.js) fall back to the bundled / fs-resident batch prompt.
//
// When the server adds a /prompt?slot=batch endpoint, fetch + cache it
// here exactly like the default slot — no other code needs to change.
export function getBatchPrompt() {
  return null;
}

// Layer 2: Encrypted disk cache
async function loadFromDisk(machineId, licenseKey) {
  if (!existsSync(PROMPT_CACHE_PATH)) return null;
  try {
    const key = await deriveKey(machineId, licenseKey);
    const data = readFileSync(PROMPT_CACHE_PATH);
    const json = decrypt(key, data);
    const { version, content, etag } = JSON.parse(json);
    _cachedEtag = etag || null;
    log.info({ version }, 'loaded prompt from disk cache');
    return content;
  } catch (err) {
    log.warn({ err: err.message }, 'failed to load prompt cache');
    return null;
  }
}

// Layer 3: Remote fetch
async function fetchFromRemote(licenseKey, etag) {
  return new Promise((resolve, reject) => {
    const url = new URL(PROMPT_API_URL);
    const headers = {
      'Authorization': `Bearer ${licenseKey}`,
    };
    if (etag) headers['If-None-Match'] = etag;

    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode === 304) {
        resolve({ notModified: true });
        return;
      }
      if (res.statusCode === 403) {
        resolve({ forbidden: true });
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const newEtag = res.headers.etag || null;
          resolve({ content: body.content, version: body.version, etag: newEtag });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

// Save to encrypted disk cache
async function saveToDisk(machineId, licenseKey, content, version, etag) {
  try {
    const key = await deriveKey(machineId, licenseKey);
    const json = JSON.stringify({ version, content, etag });
    const encrypted = encrypt(key, json);
    mkdirSync(PROMPT_CACHE_DIR, { recursive: true });
    writeFileSync(PROMPT_CACHE_PATH, encrypted);
    log.info({ version }, 'saved prompt to disk cache');
  } catch (err) {
    log.warn({ err: err.message }, 'failed to save prompt cache');
  }
}

// 3-layer fallback init
export async function initPromptLoader() {
  const licenseKey = getLicenseKey();

  // No license → free tier basic prompt
  if (!licenseKey) {
    _cachedPrompt = getBasicPrompt();
    log.info('no license, using basic prompt');
    return _cachedPrompt;
  }

  const machineId = await getMachineId();

  // Try disk cache first
  const diskPrompt = await loadFromDisk(machineId, licenseKey);
  if (diskPrompt) {
    _cachedPrompt = diskPrompt;
  }

  // Try remote (non-blocking if disk hit)
  try {
    const result = await fetchFromRemote(licenseKey, _cachedEtag);

    if (result.notModified) {
      log.info('prompt not modified (304)');
    } else if (result.forbidden) {
      log.warn('license rejected by prompt server (403)');
      if (!_cachedPrompt) _cachedPrompt = getBasicPrompt();
    } else if (result.content) {
      _cachedPrompt = result.content;
      _cachedEtag = result.etag;
      await saveToDisk(machineId, licenseKey, result.content, result.version, result.etag);
    }
  } catch (err) {
    log.warn({ err: err.message }, 'failed to fetch remote prompt');
    // Fallback: disk cache or basic
    if (!_cachedPrompt) _cachedPrompt = getBasicPrompt();
  }

  if (!_cachedPrompt) _cachedPrompt = getBasicPrompt();

  // Schedule background refresh
  _refreshTimer = setInterval(() => refreshPrompt(machineId, licenseKey), REFRESH_INTERVAL);
  if (_refreshTimer.unref) _refreshTimer.unref();

  return _cachedPrompt;
}

async function refreshPrompt(machineId, licenseKey) {
  try {
    const result = await fetchFromRemote(licenseKey, _cachedEtag);
    if (result.content) {
      _cachedPrompt = result.content;
      _cachedEtag = result.etag;
      await saveToDisk(machineId, licenseKey, result.content, result.version, result.etag);
    }
  } catch (err) {
    log.debug({ err: err.message }, 'background prompt refresh failed');
  }
}

export function stopPromptLoader() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
