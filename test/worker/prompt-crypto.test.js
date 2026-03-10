import { describe, it, expect } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../../src/worker/prompt-crypto.js';

describe('prompt-crypto', () => {
  const machineId = 'test-machine-123';
  const licenseKey = 'test-license-key-456';

  describe('deriveKey', () => {
    it('derives a 32-byte key', async () => {
      const key = await deriveKey(machineId, licenseKey);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('produces deterministic keys', async () => {
      const k1 = await deriveKey(machineId, licenseKey);
      const k2 = await deriveKey(machineId, licenseKey);
      expect(k1.equals(k2)).toBe(true);
    });

    it('produces different keys for different inputs', async () => {
      const k1 = await deriveKey(machineId, licenseKey);
      const k2 = await deriveKey(machineId, 'different-key');
      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe('encrypt/decrypt', () => {
    it('round-trips plaintext', async () => {
      const key = await deriveKey(machineId, licenseKey);
      const plaintext = '{"version":"1","content":"hello world","etag":"abc"}';
      const encrypted = encrypt(key, plaintext);
      const decrypted = decrypt(key, encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', async () => {
      const key = await deriveKey(machineId, licenseKey);
      const plaintext = 'test data';
      const e1 = encrypt(key, plaintext);
      const e2 = encrypt(key, plaintext);
      expect(e1.equals(e2)).toBe(false);
      // But both decrypt to same plaintext
      expect(decrypt(key, e1)).toBe(plaintext);
      expect(decrypt(key, e2)).toBe(plaintext);
    });

    it('rejects tampered ciphertext', async () => {
      const key = await deriveKey(machineId, licenseKey);
      const encrypted = encrypt(key, 'secret');
      // Flip a byte in the ciphertext
      encrypted[15] ^= 0xff;
      expect(() => decrypt(key, encrypted)).toThrow();
    });

    it('rejects wrong key', async () => {
      const key1 = await deriveKey(machineId, licenseKey);
      const key2 = await deriveKey(machineId, 'wrong-key');
      const encrypted = encrypt(key1, 'secret');
      expect(() => decrypt(key2, encrypted)).toThrow();
    });

    it('rejects too-short data', async () => {
      const key = await deriveKey(machineId, licenseKey);
      expect(() => decrypt(key, Buffer.alloc(20))).toThrow('too short');
    });

    it('handles unicode content', async () => {
      const key = await deriveKey(machineId, licenseKey);
      const plaintext = '你好世界 🌍 — extract entities and facts';
      const encrypted = encrypt(key, plaintext);
      expect(decrypt(key, encrypted)).toBe(plaintext);
    });

    it('handles large content', async () => {
      const key = await deriveKey(machineId, licenseKey);
      const plaintext = 'x'.repeat(100000);
      const encrypted = encrypt(key, plaintext);
      expect(decrypt(key, encrypted)).toBe(plaintext);
    });
  });
});
