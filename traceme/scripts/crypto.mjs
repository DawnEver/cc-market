// Zero-dependency AES-256-GCM encryption. Key stored as hex in ~/.claude/traceme/key.txt
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACEME_DIR } from './lib.mjs';

const KEY_FILE = process.env.TRACEME_KEY_FILE || join(TRACEME_DIR, 'key.txt');

function getKey() {
  if (!existsSync(KEY_FILE)) throw new Error('No encryption key found. Run `traceme sync setup` first.');
  return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

export function generateKey() {
  const key = randomBytes(32).toString('hex');
  writeFileSync(KEY_FILE, key + '\n', 'utf8');
  return key;
}

export function hasKey() {
  return existsSync(KEY_FILE);
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const buf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // iv(12) + authTag(16) + ciphertext → base64
  return Buffer.concat([iv, cipher.getAuthTag(), buf]).toString('base64');
}

export function decrypt(armored) {
  const key = getKey();
  const buf = Buffer.from(armored, 'base64');
  if (buf.length < 28) throw new Error('Invalid encrypted data');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
