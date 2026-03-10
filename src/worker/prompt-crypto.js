import { hkdf, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const hkdfAsync = promisify(hkdf);

const SALT = 'kiroku-prompt-cache-v1';
const INFO = 'aes-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export async function deriveKey(machineId, licenseKey) {
  const ikm = `${machineId}|${licenseKey}`;
  const key = await hkdfAsync('sha256', ikm, SALT, INFO, KEY_LEN);
  return Buffer.from(key);
}

// Encrypt: returns Buffer = [12B IV][ciphertext][16B tag]
export function encrypt(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

// Decrypt: input Buffer = [12B IV][ciphertext][16B tag]
export function decrypt(key, data) {
  if (data.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Invalid encrypted data: too short');
  }
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const ciphertext = data.subarray(IV_LEN, data.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
