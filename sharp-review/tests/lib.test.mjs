// sharp-review/lib.test.mjs — Tests for lib.mjs shared functions
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// Import the module under test
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const libPath = join(__dirname, '..', 'lib.mjs');

let lib;
try {
  lib = await import(libPath);
} catch (e) {
  // We need a project context; set one up
  const tmp = join(tmpdir(), `sharp-review-test-${Date.now()}`);
  mkdirSync(join(tmp, '.claude', 'memory'), { recursive: true });
  const orig = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp;
  lib = await import(libPath);
  process.env.CLAUDE_PROJECT_DIR = orig;
  process.on('exit', () => { try { rmSync(tmp, { recursive: true }); } catch {} });
}

const { SR_ID_RE, SR_ID_PARSE_RE, inferModule, inferCategory, findingMemoryPath } = lib;

describe('SR_ID_RE', () => {
  it('matches SR-YYYYMMDD-NNN format', () => {
    const m = 'SR-20260604-001'.match(SR_ID_RE);
    assert.ok(m);
    assert.equal(m[0], 'SR-20260604-001');
  });

  it('does not match invalid formats', () => {
    assert.equal(SR_ID_RE.test('SR-2026-001'), false);
    assert.equal(SR_ID_RE.test('SR-20260604-1'), false);
  });

  it('matches multiple IDs in text', () => {
    const text = 'See [[SR-20260604-001]] and [[SR-20260604-015]] for details';
    const matches = [...text.matchAll(SR_ID_RE)];
    assert.equal(matches.length, 2);
  });
});

describe('SR_ID_PARSE_RE', () => {
  it('parses date and sequence', () => {
    const m = 'SR-20260604-015'.match(SR_ID_PARSE_RE);
    assert.ok(m);
    assert.equal(m[1], '20260604');
    assert.equal(m[2], '015');
  });
});

describe('inferModule', () => {
  it('maps takeover paths', () => {
    assert.equal(inferModule('cc-market/takeover/lib.mjs'), 'takeover plugin');
  });

  it('maps notify paths', () => {
    assert.equal(inferModule('scripts/hooks/notify-hook.js'), 'notify hook');
  });

  it('falls back to directory name', () => {
    assert.equal(inferModule('some/unknown/dir/file.js'), 'dir');
  });

  it('returns unknown for empty path', () => {
    assert.equal(inferModule(''), 'unknown');
    assert.equal(inferModule(null), 'unknown');
  });
});

describe('inferCategory', () => {
  it('detects performance from summary', () => {
    assert.equal(inferCategory('fix slow memory leak in loop'), 'Performance');
  });

  it('detects feature from summary', () => {
    assert.equal(inferCategory('add support for new API'), 'Feature');
  });

  it('defaults to Bug', () => {
    assert.equal(inferCategory('fix typo'), 'Bug');
    assert.equal(inferCategory(null), 'Bug');
  });

  it('respects explicit category', () => {
    assert.equal(inferCategory('slow code', 'Performance'), 'Performance');
    assert.equal(inferCategory('broken code', 'Bug'), 'Bug');
  });
});

describe('findingMemoryPath', () => {
  it('derives date dir from SR-ID', () => {
    const f = { id: 'SR-20260604-001', discovered: '2026-06-04' };
    const pm = findingMemoryPath(f);
    assert.ok(pm);
    assert.equal(pm.dir, '2026-06-04');
    assert.equal(pm.file, 'SR-20260604-001.md');
    assert.equal(pm.relPath, '2026-06-04/SR-20260604-001.md');
  });

  it('returns null for missing date', () => {
    const f = { id: 'SR-20260604-001', discovered: '' };
    assert.equal(findingMemoryPath(f), null);
  });
});
