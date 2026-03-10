import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('license-state (LS integration)', () => {
  const statePath = join(ROOT, 'src', 'license', 'license-state.js');
  const source = readFileSync(statePath, 'utf8');

  describe('module structure', () => {
    it('exports getLicenseState, isLicensed, resetLicenseCache', () => {
      expect(source).toContain('export async function getLicenseState');
      expect(source).toContain('export async function isLicensed');
      expect(source).toContain('export function resetLicenseCache');
    });
  });

  describe('LS validate integration', () => {
    it('calls LS validate API', () => {
      expect(source).toContain('api.lemonsqueezy.com/v1/licenses/validate');
    });

    it('validates using license key from LICENSE_KEY_PATH', () => {
      expect(source).toContain('LICENSE_KEY_PATH');
      expect(source).toContain('getLicenseKey');
    });

    it('caches validation result with TTL', () => {
      expect(source).toContain('VALIDATE_CACHE_TTL');
      expect(source).toContain('_lastValidated');
    });
  });

  describe('offline grace period', () => {
    it('saves offline state for grace period', () => {
      expect(source).toContain('saveOfflineState');
      expect(source).toContain('OFFLINE_LICENSE_PATH');
    });

    it('loads offline state when LS unreachable', () => {
      expect(source).toContain('loadOfflineState');
    });

    it('defines 7-day grace period', () => {
      expect(source).toContain('GRACE_PERIOD_MS');
      expect(source).toContain('7 * 24 * 60 * 60 * 1000');
    });

    it('falls back to free tier when grace expired', () => {
      expect(source).toContain('freeTierState');
    });
  });

  describe('backward compatibility', () => {
    it('falls back to Ed25519 verify when no license.key', () => {
      expect(source).toContain('verifyLicense');
      expect(source).toContain("import { verifyLicense } from './verify.js'");
    });
  });
});

describe('verify.js (multi-key rotation)', () => {
  const verifyPath = join(ROOT, 'src', 'license', 'verify.js');
  const source = readFileSync(verifyPath, 'utf8');

  it('uses PUBLIC_KEYS array', () => {
    expect(source).toContain('PUBLIC_KEYS');
    expect(source).toContain("id: 'k1'");
  });

  it('tries all keys via tryVerifySignature', () => {
    expect(source).toContain('tryVerifySignature');
    expect(source).toContain('for (const pk of PUBLIC_KEYS)');
  });

  it('supports dual fingerprint (hardware + legacy)', () => {
    expect(source).toContain('getMachineId');
    expect(source).toContain('getMachineIdLegacy');
    expect(source).toContain('payload.mid !== machineId && payload.mid !== legacyId');
  });

  it('returns keyId on successful verification', () => {
    expect(source).toContain('keyId');
  });
});
