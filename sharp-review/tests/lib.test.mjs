// sharp-review/lib.test.mjs — Tests for lib.mjs shared functions
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';

// Import the module under test
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const libPath = join(__dirname, '..', 'scripts', 'lib.mjs');

let lib;
try {
  lib = await import(pathToFileURL(libPath).href);
} catch (e) {
  // We need a project context; set one up
  const tmp = join(tmpdir(), `sharp-review-test-${Date.now()}`);
  mkdirSync(join(tmp, '.claude', 'memory'), { recursive: true });
  const orig = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp;
  lib = await import(pathToFileURL(libPath).href);
  process.env.CLAUDE_PROJECT_DIR = orig;
  process.on('exit', () => { try { rmSync(tmp, { recursive: true }); } catch {} });
}

const { SR_ID_RE, SR_ID_PARSE_RE, reviewFrontmatter, parseFindingsFromMarkdown, mergeFollowup } = lib;
const { isFindingId } = await import(pathToFileURL(join(__dirname, '..', 'shared', 'lib.mjs')).href);

describe('mergeFollowup', () => {
  const F = (id, summary) => ({ id, summary, severity: 'LOW', status: 'OPEN' });

  it('folds a follow-up in by stable id: a repeated id is not appended again', () => {
    const existing = [F('F-0123456789ab', 'old one')];
    const incoming = [F('F-0123456789ab', 'same finding'), F('F-ba9876543210', 'new one')];
    const r = mergeFollowup(existing, incoming);
    assert.deepEqual(r.findings.map((f) => f.id), ['F-0123456789ab', 'F-ba9876543210']);
    assert.deepEqual(r.fresh.map((f) => f.id), ['F-ba9876543210']);
    assert.deepEqual(r.repeated, ['F-0123456789ab']);
  });

  it('keeps every finding of a report written before v3 (SR ids) beside the new ones', () => {
    const r = mergeFollowup([F('SR-20260615-001', 'x')], [F('F-0123456789ab', 'y')]);
    assert.deepEqual(r.findings.map((f) => f.id), ['SR-20260615-001', 'F-0123456789ab']);
    assert.deepEqual(r.repeated, []);
  });
});

describe('finding ids', () => {
  it('reads both id forms, and parses an F-id header with the run date as its discovery', () => {
    const md = '### [F-0123456789ab] [HIGH] a.js — leak\n- **Status:** OPEN\n\n### [SR-20260604-001] [LOW] b.js — old\n';
    const found = parseFindingsFromMarkdown(md, '2026-10-26');
    assert.deepEqual(found.map((f) => [f.id, f.discovered]), [['F-0123456789ab', '2026-10-26'], ['SR-20260604-001', '2026-06-04']]);
    assert.ok(isFindingId('F-0123456789ab') && isFindingId('SR-20260604-001'));
    assert.equal(isFindingId('F-123'), false);
  });
});

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

describe('reviewFrontmatter', () => {
  it('generates frontmatter with total count', () => {
    const findings = [
      { id: 'SR-20260607-001', status: 'fixed' },
      { id: 'SR-20260607-002', status: 'open' },
      { id: 'SR-20260607-003', status: 'open' },
    ];
    const fm = reviewFrontmatter(findings, '2026-06-07');
    assert.ok(fm.includes('name: sharp-review-2026-06-07'));
    assert.ok(fm.includes('3 total'));
    assert.ok(fm.includes('name: sharp-review-2026-06-07'));
  });

  it('handles empty findings', () => {
    const fm = reviewFrontmatter([], '2026-06-07');
    assert.ok(fm.includes('0 total'));
  });
});

describe('parseFindingsFromMarkdown', () => {
  const sample = `# Sharp Review — 2026-06-07

### [SR-20260607-001] [HIGH] .gitignore — Some issue
- **Category:** Bug
- **Module:** test
- **Status:** FIXED
- **Suggestion:** Fix it

---

### [SR-20260607-002] [MEDIUM] lib.mjs — Another thing
- **Category:** Feature
- **Status:** OPEN

---

### [SR-20260607-003] [LOW] test.js — Missing status defaults to open
- **Suggestion:** Add it
`;

  it('parses FIXED status', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    assert.equal(findings.length, 3);
    assert.equal(findings[0].status, 'fixed');
    assert.equal(findings[0].resolvedDate, '2026-06-07');
  });

  it('parses OPEN status', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    assert.equal(findings[1].status, 'open');
    assert.equal(findings[1].resolvedDate, null);
  });

  it('defaults missing status to open', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    assert.equal(findings[2].status, 'open');
  });

  it('extracts file path', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    assert.equal(findings[0].file, '.gitignore');
    assert.equal(findings[1].file, 'lib.mjs');
  });

  it('uses explicit Module field when present', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    assert.equal(findings[0].module, 'test');
  });

  it('infers module from file path when no explicit field', () => {
    const findings = parseFindingsFromMarkdown(sample, '2026-06-07');
    // test.js (root file) → basename without extension
    assert.equal(findings[2].module, 'test');
    // lib.mjs (root file) → basename without extension
    assert.equal(findings[1].module, 'lib');
  });

  it('handles empty content', () => {
    const findings = parseFindingsFromMarkdown('', '2026-06-07');
    assert.equal(findings.length, 0);
  });
});
