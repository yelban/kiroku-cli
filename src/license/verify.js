import { existsSync, readFileSync } from 'node:fs';
import { verify, createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { LICENSE_DIR } from '../shared/paths.js';
import { getMachineId, getMachineIdLegacy } from './machine-id.js';

const LICENSE_PATH = join(LICENSE_DIR, 'license.dat');

// Multi-key rotation: try all keys in order
const PUBLIC_KEYS = [
  {
    id: 'k1',
    key: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnlpYuKwUhVdlpkQEg7ITpwCwlDQiP66YlB78L4o5amw=
-----END PUBLIC KEY-----`,
    validFrom: '2026-01-01',
  },
  // Add future keys here:
  // { id: 'k2', key: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----', validFrom: '2027-01-01' },
];

function tryVerifySignature(signedData, sigBuf) {
  for (const pk of PUBLIC_KEYS) {
    try {
      const key = createPublicKey(pk.key);
      if (verify(null, signedData, key, sigBuf)) {
        return { verified: true, keyId: pk.id };
      }
    } catch {
      // Key format error, try next
    }
  }
  return { verified: false };
}

// Offline Ed25519 license verification (Phase 1 system)
// Used as fallback when LS API is unavailable
export async function verifyLicense() {
  if (!existsSync(LICENSE_PATH)) {
    const machineId = await getMachineId();
    return { valid: false, error: 'License file not found', machineId };
  }

  try {
    const licenseData = readFileSync(LICENSE_PATH, 'utf8').trim();
    const [payloadB64, signatureHex] = licenseData.split('.');

    if (!payloadB64 || !signatureHex) {
      return { valid: false, error: 'Malformed license format' };
    }

    const signedData = Buffer.from(payloadB64);
    const sigBuf = Buffer.from(signatureHex, 'hex');

    const { verified, keyId } = tryVerifySignature(signedData, sigBuf);
    if (!verified) {
      return { valid: false, error: 'Invalid signature (all keys tried)' };
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

    // Dual fingerprint: accept either new hardware-level or legacy MAC-based ID
    const machineId = await getMachineId();
    const legacyId = getMachineIdLegacy();
    if (payload.mid !== machineId && payload.mid !== legacyId) {
      return { valid: false, error: 'Machine ID mismatch', machineId };
    }

    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, error: 'License expired', machineId };
    }

    return { valid: true, payload, machineId, keyId };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
