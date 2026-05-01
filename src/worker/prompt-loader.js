import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KIROKU_ROOT, PROMPT_CACHE_PATH, PROMPT_CACHE_DIR, LICENSE_KEY_PATH } from '../shared/paths.js';
import { getMachineId } from '../license/machine-id.js';
import { deriveKey, encrypt, decrypt } from './prompt-crypto.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('prompt-loader');

const PROMPT_API_URL = 'https://kiroku-api.twampd.workers.dev/prompt';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24h

// Slot table — each slot keeps its own memory cache + etag and points
// to its own encrypted disk cache file. The 'default' slot's disk cache
// stays at PROMPT_CACHE_PATH for backward compat with pre-1.7.16 caches.
const SLOTS = ['default', 'batch'];
const _state = {
  default: { content: null, etag: null },
  batch: { content: null, etag: null },
};

let _refreshTimer = null;

function diskPathFor(slot) {
  if (slot === 'default') return PROMPT_CACHE_PATH;
  return join(PROMPT_CACHE_DIR, `prompt-${slot}.enc`);
}

// Embedded basic prompt (free tier fallback for the default slot)
function getBasicPrompt() {
  const basicPath = join(KIROKU_ROOT, 'prompts', 'extraction-basic.md');
  if (existsSync(basicPath)) {
    return readFileSync(basicPath, 'utf8');
  }
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

// Layer 1: Memory cache, default slot
export function getPrompt() {
  return _state.default.content || getBasicPrompt();
}

// Layer 1: Memory cache, batch slot. Returns null if the server hasn't
// pushed a batch prompt for this license yet — extractor.js will fall
// back to the bundled / fs-resident copy.
export function getBatchPrompt() {
  return _state.batch.content;
}

// Layer 2: Encrypted disk cache (per slot)
async function loadSlotFromDisk(slot, machineId, licenseKey) {
  const path = diskPathFor(slot);
  if (!existsSync(path)) return null;
  try {
    const key = await deriveKey(machineId, licenseKey);
    const data = readFileSync(path);
    const json = decrypt(key, data);
    const parsed = JSON.parse(json);
    _state[slot].etag = parsed.etag || null;
    log.info({ slot, version: parsed.version }, 'loaded prompt from disk cache');
    return parsed.content;
  } catch (err) {
    log.warn({ slot, err: err.message }, 'failed to load prompt cache');
    return null;
  }
}

// Layer 3: Remote fetch (per slot, ?slot=<slot> query param)
async function fetchSlotFromRemote(slot, licenseKey, etag) {
  return new Promise((resolve, reject) => {
    const url = new URL(PROMPT_API_URL);
    if (slot && slot !== 'default') url.searchParams.set('slot', slot);
    const headers = { 'Authorization': `Bearer ${licenseKey}` };
    if (etag) headers['If-None-Match'] = etag;

    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode === 304) { resolve({ notModified: true }); return; }
      if (res.statusCode === 403) { resolve({ forbidden: true }); return; }
      if (res.statusCode === 404) { resolve({ notAvailable: true }); return; }
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

async function saveSlotToDisk(slot, machineId, licenseKey, content, version, etag) {
  try {
    const key = await deriveKey(machineId, licenseKey);
    const json = JSON.stringify({ version, content, etag, slot });
    const encrypted = encrypt(key, json);
    mkdirSync(PROMPT_CACHE_DIR, { recursive: true });
    writeFileSync(diskPathFor(slot), encrypted);
    log.info({ slot, version }, 'saved prompt to disk cache');
  } catch (err) {
    log.warn({ slot, err: err.message }, 'failed to save prompt cache');
  }
}

async function loadOneSlot(slot, machineId, licenseKey) {
  // Try disk cache first
  const disk = await loadSlotFromDisk(slot, machineId, licenseKey);
  if (disk) _state[slot].content = disk;

  // Then try remote (best-effort)
  try {
    const result = await fetchSlotFromRemote(slot, licenseKey, _state[slot].etag);
    if (result.notModified) {
      log.info({ slot }, 'prompt not modified (304)');
    } else if (result.forbidden) {
      log.warn({ slot }, 'license rejected by prompt server (403)');
    } else if (result.notAvailable) {
      log.info({ slot }, 'prompt slot not available on server (404), using local fallback');
    } else if (result.content) {
      _state[slot].content = result.content;
      _state[slot].etag = result.etag;
      await saveSlotToDisk(slot, machineId, licenseKey, result.content, result.version, result.etag);
    }
  } catch (err) {
    log.warn({ slot, err: err.message }, 'failed to fetch remote prompt');
  }
}

// 3-layer fallback init across both slots
export async function initPromptLoader() {
  const licenseKey = getLicenseKey();

  // No license → free tier basic prompt for default; batch slot stays
  // null and the extractor falls back to its embedded copy.
  if (!licenseKey) {
    _state.default.content = getBasicPrompt();
    log.info('no license, using basic prompt for default slot');
    return _state.default.content;
  }

  const machineId = await getMachineId();
  for (const slot of SLOTS) {
    await loadOneSlot(slot, machineId, licenseKey);
  }

  // Default slot must always have something
  if (!_state.default.content) _state.default.content = getBasicPrompt();

  // Schedule background refresh of every slot
  _refreshTimer = setInterval(() => refreshAllSlots(machineId, licenseKey), REFRESH_INTERVAL);
  if (_refreshTimer.unref) _refreshTimer.unref();

  return _state.default.content;
}

async function refreshAllSlots(machineId, licenseKey) {
  for (const slot of SLOTS) {
    try {
      const result = await fetchSlotFromRemote(slot, licenseKey, _state[slot].etag);
      if (result.content) {
        _state[slot].content = result.content;
        _state[slot].etag = result.etag;
        await saveSlotToDisk(slot, machineId, licenseKey, result.content, result.version, result.etag);
      }
    } catch (err) {
      log.debug({ slot, err: err.message }, 'background prompt refresh failed');
    }
  }
}

export function stopPromptLoader() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
