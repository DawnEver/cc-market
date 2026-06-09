import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const cryptoModPath = '../scripts/crypto.mjs';

describe('Crypto (AES-256-GCM)', () => {
  before(() => {
    process.env.TRACEME_KEY_FILE = join(tmpdir(), `traceme-key-${randomUUID()}.txt`);
  });

  after(() => {
    if (process.env.TRACEME_KEY_FILE) {
      try { unlinkSync(process.env.TRACEME_KEY_FILE); } catch {}
      delete process.env.TRACEME_KEY_FILE;
    }
  });

  it('generateKey should create a 64-char hex string', async () => {
    const { generateKey, hasKey } = await import(cryptoModPath);
    assert.equal(hasKey(), false);
    const key = generateKey();
    assert.equal(key.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(key));
    assert.equal(hasKey(), true);
  });

  it('encrypt/decrypt round-trip', async () => {
    const { encrypt, decrypt } = await import(cryptoModPath);
    const payload = JSON.stringify({ date: '2026-06-09', tokens: 145313116, cost: 2.8922 });
    const armor = encrypt(payload);
    assert.ok(armor.length > 0);
    assert.ok(typeof armor === 'string');
    const decrypted = decrypt(armor);
    assert.equal(decrypted, payload);
  });

  it('encrypt produces different output for same plaintext (unique IV)', async () => {
    const { encrypt } = await import(cryptoModPath);
    const plain = 'hello traceme';
    const a = encrypt(plain);
    const b = encrypt(plain);
    assert.notEqual(a, b); // different IV each time
  });

  it('decrypt rejects tampered data', async () => {
    const { encrypt, decrypt } = await import(cryptoModPath);
    const armor = encrypt('secret');
    const tampered = armor.slice(0, -4) + 'XXXX';
    assert.throws(() => decrypt(tampered));
  });

  it('decrypt rejects truncated data', async () => {
    const { decrypt } = await import(cryptoModPath);
    assert.throws(() => decrypt('abc'));
  });

  it('encrypt rejects when no key exists', async () => {
    // Unlink key and verify it's missing
    if (process.env.TRACEME_KEY_FILE) {
      try { unlinkSync(process.env.TRACEME_KEY_FILE); } catch {}
    }
    const { encrypt } = await import(cryptoModPath);
    assert.throws(() => encrypt('data'), /No encryption key found/);
  });

  it('decrypt rejects when no key exists', async () => {
    const { decrypt } = await import(cryptoModPath);
    assert.throws(() => decrypt('dGVzdA=='), /No encryption key found/);
  });

  it('large payload round-trip (1MB)', async () => {
    const { generateKey, encrypt, decrypt } = await import(cryptoModPath);
    generateKey(); // re-create key
    const large = 'x'.repeat(1_000_000);
    const armor = encrypt(large);
    const decrypted = decrypt(armor);
    assert.equal(decrypted, large);
    assert.ok(armor.length < large.length * 1.5); // base64 + overhead < 1.5x
  });

  it('unicode round-trip (CJK)', async () => {
    const { encrypt, decrypt } = await import(cryptoModPath);
    const payload = JSON.stringify({ prompt: '多平台加密同步 MVP', tokens: 145_000_000 });
    const armor = encrypt(payload);
    assert.equal(decrypt(armor), payload);
  });
});
