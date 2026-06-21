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

const { SR_ID_RE, SR_ID_PARSE_RE, inferCategory, reviewFrontmatter, parseFindingsFromMarkdown, mergeFollowup } = lib;

describe('mergeFollowup', () => {
  const F = (id, summary) => ({ id, summary, severity: 'LOW', status: 'OPEN' });

  it('renumbers colliding incoming ids and rewrites the markdown (no data loss)', () => {
    const existing = [F('SR-20260615-001', 'old one')];
    const incoming = [F('SR-20260615-001', 'new A'), F('SR-20260615-002', 'new B')];
    const md = '### [SR-20260615-001] new A\n### [SR-20260615-002] new B\n';
    const r = mergeFollowup(existing, incoming, md);
    // existing kept; both incoming kept (none dropped) → 3 total
    assert.equal(r.findings.length, 3);
    assert.equal(r.renumbered, 2);
    // incoming ids renumbered to continue after max existing seq (001) → 002, 003
    assert.deepEqual(r.findings.map(f => f.id), ['SR-20260615-001', 'SR-20260615-002', 'SR-20260615-003']);
    // markdown ids rewritten to match
    assert.ok(r.markdown.includes('[SR-20260615-002] new A'));
    assert.ok(r.markdown.includes('[SR-20260615-003] new B'));
    // the original existing finding (separate id space) is untouched here
  });

  it('is cascade-safe when existing has fewer findings than incoming', () => {
    // existing maxSeq=1; incoming 001,002,003 → new 002,003,004. oldIds and newIds overlap.
    const existing = [F('SR-20260615-001', 'x')];
    const incoming = [F('SR-20260615-001', 'a'), F('SR-20260615-002', 'b'), F('SR-20260615-003', 'c')];
    const md = '[SR-20260615-001]a [SR-20260615-002]b [SR-20260615-003]c';
    const r = mergeFollowup(existing, incoming, md);
    assert.deepEqual(r.findings.slice(1).map(f => f.id), ['SR-20260615-002', 'SR-20260615-003', 'SR-20260615-004']);
    // single-pass rewrite: each old id maps exactly once, no double-shift
    assert.equal(r.markdown, '[SR-20260615-002]a [SR-20260615-003]b [SR-20260615-004]c');
  });

  it('appends incoming contiguously after existing max seq (renumber-all)', () => {
    const existing = [F('SR-20260615-001', 'x')];
    const incoming = [F('SR-20260615-009', 'y')];
    const md = '[SR-20260615-009] y';
    const r = mergeFollowup(existing, incoming, md);
    assert.equal(r.renumbered, 1);                         // 009 → 002 (contiguous)
    assert.equal(r.markdown, '[SR-20260615-002] y');
    assert.deepEqual(r.findings.map(f => f.id), ['SR-20260615-001', 'SR-20260615-002']);
  });

  it('no-ops the markdown when incoming already starts right after existing', () => {
    const existing = [F('SR-20260615-001', 'x')];
    const incoming = [F('SR-20260615-002', 'y')];   // already 002, maxSeq+1 → stays 002
    const md = '[SR-20260615-002] y';
    const r = mergeFollowup(existing, incoming, md);
    assert.equal(r.renumbered, 0);
    assert.equal(r.markdown, md);
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
