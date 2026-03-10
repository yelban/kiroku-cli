import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { verifyLicense } from './verify.js';
import { getMachineId } from './machine-id.js';
import { loadConfig } from '../shared/config.js';
import { LICENSE_KEY_PATH, OFFLINE_LICENSE_PATH } from '../shared/paths.js';
import { FREEMIUM_FACT_LIMIT, FREEMIUM_DAILY_EXTRACT_LIMIT } from '../shared/constants.js';

const LS_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const VALIDATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Security: reject keys from other LS products
const EXPECTED_STORE_ID = 309745;
const EXPECTED_PRODUCT_ID = 876026;

let _state = null;
let _lastValidated = 0;

function getLicenseKey() {
  if (!existsSync(LICENSE_KEY_PATH)) return null;
  try { return readFileSync(LICENSE_KEY_PATH, 'utf8').trim(); } catch { return null; }
}

// Call LS validate API
async function validateWithLS(licenseKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ license_key: licenseKey });
    const req = https.request(LS_VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data);
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Save offline license state for grace period (preserves instanceId from activate)
function saveOfflineState(state) {
  try {
    const existing = loadOfflineState() || {};
    writeFileSync(OFFLINE_LICENSE_PATH, JSON.stringify({
      ...existing,
      ...state,
      validatedAt: Date.now(),
    }));
  } catch { /* best-effort */ }
}

// Load offline license state
function loadOfflineState() {
  if (!existsSync(OFFLINE_LICENSE_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(OFFLINE_LICENSE_PATH, 'utf8'));
    return data;
  } catch { return null; }
}

function freeTierState(machineId, cfg) {
  return {
    licensed: false,
    tier: 'free',
    expiry: null,
    machineId,
    factLimit: cfg?.license?.freemium?.factLimit || FREEMIUM_FACT_LIMIT,
    dailyExtractLimit: cfg?.license?.freemium?.dailyExtractLimit || FREEMIUM_DAILY_EXTRACT_LIMIT,
    embeddingEnabled: cfg?.license?.freemium?.embeddingEnabled ?? false,
  };
}

export async function getLicenseState() {
  // Return cached state if within TTL
  if (_state && Date.now() - _lastValidated < VALIDATE_CACHE_TTL) {
    return _state;
  }

  const cfg = loadConfig();
  const licenseKey = getLicenseKey();

  // No license key → check Phase 1 Ed25519 license, then free tier
  if (!licenseKey) {
    const result = await verifyLicense();
    if (result.valid) {
      _state = {
        licensed: true,
        tier: result.payload.tier || 'pro',
        expiry: result.payload.exp ? new Date(result.payload.exp) : null,
        machineId: result.machineId,
        factLimit: Infinity,
        dailyExtractLimit: Infinity,
        embeddingEnabled: true,
      };
    } else {
      _state = freeTierState(result.machineId, cfg);
    }
    _lastValidated = Date.now();
    return _state;
  }

  // Has license key → validate via Lemon Squeezy
  const machineId = await getMachineId();
  try {
    const data = await validateWithLS(licenseKey);

    // Verify store_id/product_id to prevent cross-product key abuse
    if (data.meta?.store_id !== EXPECTED_STORE_ID || data.meta?.product_id !== EXPECTED_PRODUCT_ID) {
      _state = freeTierState(machineId, cfg);
      _lastValidated = Date.now();
      return _state;
    }

    if (data.valid) {
      const tier = data.license_key?.status === 'active' ? 'pro' : 'free';
      _state = {
        licensed: true,
        tier,
        expiry: data.license_key?.expires_at ? new Date(data.license_key.expires_at) : null,
        machineId,
        factLimit: Infinity,
        dailyExtractLimit: Infinity,
        embeddingEnabled: true,
      };
      _lastValidated = Date.now();
      saveOfflineState(_state);
      return _state;
    }

    // LS says invalid
    _state = freeTierState(machineId, cfg);
    _lastValidated = Date.now();
    return _state;

  } catch {
    // Offline → check grace period
    const offline = loadOfflineState();
    if (offline && offline.licensed && Date.now() - offline.validatedAt < GRACE_PERIOD_MS) {
      _state = { ...offline, machineId };
      _lastValidated = Date.now();
      return _state;
    }

    // Grace expired or no offline state
    _state = freeTierState(machineId, cfg);
    _lastValidated = Date.now();
    return _state;
  }
}

export async function isLicensed() {
  const state = await getLicenseState();
  return state.licensed;
}

export function resetLicenseCache() {
  _state = null;
  _lastValidated = 0;
}
