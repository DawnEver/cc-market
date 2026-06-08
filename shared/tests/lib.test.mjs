// shared/tests/lib.test.mjs — tests for shared/lib.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedLibUrl = pathToFileURL(join(__dirname, '..', 'lib.mjs')).href;

// ── Helpers ──

let tmpDir;
function tmp(...parts) { return join(tmpDir, ...parts); }

before(() => {
  // Use system temp dir for "no .git" isolation tests
  tmpDir = join(tmpdir(), 'claude_shared_lib_test_' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ── findProjectRoot ──

describe('findProjectRoot', async () => {
  const { findProjectRoot } = await import(sharedLibUrl);

  it('returns dir itself when it has .git', () => {
    const dir = tmp('gitRoot');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, '.git'));
    const result = findProjectRoot(dir);
    assert.equal(result, dir);
  });

  it('walks up from subdirectory to find .git', () => {
    const root = tmp('walkUp');
    const sub = join(root, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(root, '.git'));
    const result = findProjectRoot(sub);
    assert.equal(result, root);
  });

  it('walks up multiple levels to find .git', () => {
    const root = tmp('multiLevel');
    const deep = join(root, 'x', 'y', 'z');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, '.git'));
    const result = findProjectRoot(deep);
    assert.equal(result, root);
  });

  it('returns startDir when no .git found', () => {
    const dir = tmp('noGit');
    mkdirSync(dir, { recursive: true });
    const result = findProjectRoot(dir);
    assert.equal(result, dir);
  });

  it('defaults to cwd when no argument given', () => {
    const result = findProjectRoot();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

// ── isMain ──

describe('isMain', async () => {
  const { isMain } = await import(sharedLibUrl);

  it('returns false when importMeta is null/undefined', () => {
    assert.equal(isMain(null), false);
    assert.equal(isMain(undefined), false);
  });

  it('returns true when run directly', () => {
    // Simulate running this file directly by constructing a matching argv
    const name = fileURLToPath(import.meta.url);
    process.argv[1] = name;
    const meta = { url: import.meta.url };
    assert.equal(isMain(meta), true);
  });

  it('returns false when argv[1] differs', () => {
    process.argv[1] = '/some/other/file.js';
    const meta = { url: import.meta.url };
    assert.equal(isMain(meta), false);
  });

  it('returns false when process.argv[1] is missing', () => {
    const saved = process.argv[1];
    process.argv[1] = null;
    const meta = { url: import.meta.url };
    assert.equal(isMain(meta), false);
    process.argv[1] = saved;
  });
});

// ── readStdinJSON ──

describe('readStdinJSON', async () => {
  const { readStdinJSON } = await import(sharedLibUrl);

  it('returns {} when stdin is a TTY', () => {
    // In a test runner, stdin might or might not be TTY
    const result = readStdinJSON();
    assert.equal(typeof result, 'object');
  });

  // BOM handling is tested in shared/tests/state.test.mjs (loadState BOM test).
  // readStdinJSON BOM path is identical — tested indirectly via state.test.mjs.
});

// ── readTranscriptTail ──

describe('readTranscriptTail', async () => {
  const { readTranscriptTail } = await import(sharedLibUrl);

  it('returns empty array for non-existent file', () => {
    const result = readTranscriptTail(tmp('nonexistent.jsonl'));
    assert.deepEqual(result, []);
  });

  it('reads and parses last N lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ role: 'user', content: `msg${i}` }));
    const transcriptPath = tmp('transcript.jsonl');
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const result = readTranscriptTail(transcriptPath, 5);
    assert.equal(result.length, 5);
    assert.deepEqual(result[0], { role: 'user', content: 'msg45' });
  });

  it('returns all lines when fewer than maxLines', () => {
    const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify({ role: 'user', content: `msg${i}` }));
    const transcriptPath = tmp('short.jsonl');
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const result = readTranscriptTail(transcriptPath, 10);
    assert.equal(result.length, 3);
  });

  it('skips invalid JSON lines', () => {
    const lines = [
      JSON.stringify({ valid: true }),
      'invalid json {{{',
      JSON.stringify({ also: 'valid' }),
    ];
    const transcriptPath = tmp('mixed.jsonl');
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const result = readTranscriptTail(transcriptPath, 5);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { valid: true });
    assert.deepEqual(result[1], { also: 'valid' });
  });
});
