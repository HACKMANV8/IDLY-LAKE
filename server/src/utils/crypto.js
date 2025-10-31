import crypto from 'crypto';
import { CONFIG } from '../config.js';

// AES-256-GCM with random IV and auth tag appended
export function encryptToken(plaintext) {
  const keyBase64 = CONFIG.ENCRYPTION_KEY_BASE64;
  if (!keyBase64) throw new Error('ENCRYPTION_KEY_BASE64 missing');
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must be 32 bytes base64');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptToken(encryptedBase64) {
  const keyBase64 = CONFIG.ENCRYPTION_KEY_BASE64;
  if (!keyBase64) throw new Error('ENCRYPTION_KEY_BASE64 missing');
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must be 32 bytes base64');

  const payload = Buffer.from(encryptedBase64, 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext;
}


