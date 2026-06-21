// sharp-review/tests/manifest.test.mjs — Tests for diff manifest functions
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { pathToFileURL } from 'url';

const libPath = join(import.meta.dirname, '..', 'scripts', 'lib.mjs');
const lib = await import(pathToFileURL(libPath).href);

const {
  classifyLowValue,
  parseNumstatZ,
  parseNameStatusZ,
  buildManifest,
  decideMode,
  decideManifestMode,
  renderManifestText,
  extractHunkHeaders,
  filterDiff,
  INLINE_DIFF_LIMIT_DEFAULT,
  MANIFEST_TEXT_BUDGET,
  MAX_HUNKS_PER_FILE,
} = lib;

// ── decideManifestMode ──

describe('decideManifestMode', () => {
  it("returns 'empty' only when there are no entries", () => {
    assert.equal(decideManifestMode(0, 0, 20000), 'empty');
    assert.equal(decideManifestMode(0, 5000, 20000), 'empty');
  });

  it("returns 'agent' when entries exist but diff text is empty (oversized/failed full diff)", () => {
    assert.equal(decideManifestMode(3, 0, 20000), 'agent');
  });

  it('falls back to size-based decision when entries and diff text are present', () => {
    assert.equal(decideManifestMode(2, 100, 20000), 'review');
    assert.equal(decideManifestMode(2, 50000, 20000), 'agent');
  });
});

// ── filterDiff ──

describe('filterDiff', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/old.lock b/new.lock',
    'similarity index 100%',
    'rename from old.lock',
    'rename to new.lock',
  ].join('\n') + '\n';

  it('returns the full diff when nothing is excluded', () => {
    assert.equal(filterDiff(diff, new Set()), diff);
  });

  it('strips a renamed excluded file matched by its NEW (b/) path', () => {
    // buildManifest keys excluded entries by the new path; the rename moved old.lock→new.lock.
    const out = filterDiff(diff, new Set(['new.lock']));
    assert.ok(out.includes('a/src/app.js'));
    assert.ok(!out.includes('new.lock'), 'renamed excluded segment must be removed');
    assert.ok(!out.includes('old.lock'));
  });

  it('does NOT strip when only the old (a/) path is in the excluded set (regression guard)', () => {
    // The old buggy code matched a/; ensure we now match b/ so the old path alone does not filter.
    const out = filterDiff(diff, new Set(['old.lock']));
    assert.ok(out.includes('new.lock'), 'matching the a/ path must no longer strip the segment');
  });

  it('strips a normal (non-rename) excluded file', () => {
    const out = filterDiff(diff, new Set(['src/app.js']));
    assert.ok(!out.includes('a/src/app.js'));
    assert.ok(out.includes('new.lock'));
  });
});

// ── classifyLowValue ──

describe('classifyLowValue', () => {
  it('detects lockfiles (bare)', () => {
    assert.equal(classifyLowValue('package-lock.json'), 'lockfile');
    assert.equal(classifyLowValue('yarn.lock'), 'lockfile');
    assert.equal(classifyLowValue('Cargo.lock'), 'lockfile');
    assert.equal(classifyLowValue('go.sum'), 'lockfile');
  });

  it('detects lockfiles (nested)', () => {
    assert.equal(classifyLowValue('subdir/package-lock.json'), 'lockfile');
    assert.equal(classifyLowValue('a/b/c/pnpm-lock.yaml'), 'lockfile');
    assert.equal(classifyLowValue('deep/nested/yarn.lock'), 'lockfile');
  });

  it('detects minified files', () => {
    assert.equal(classifyLowValue('app.min.js'), 'minified');
    assert.equal(classifyLowValue('styles.min.css'), 'minified');
  });

  it('detects generated/vendored paths', () => {
    assert.equal(classifyLowValue('dist/bundle.js'), 'generated (dist)');
    assert.equal(classifyLowValue('build/output.js'), 'generated (build)');
    assert.equal(classifyLowValue('vendor/lib.js'), 'vendored');
    assert.equal(classifyLowValue('node_modules/pkg/index.js'), 'vendored');
    assert.equal(classifyLowValue('src/__snapshots__/test.js.snap'), 'generated (snapshots)');
  });

  it('does NOT match false positives', () => {
    assert.equal(classifyLowValue('src/locker.js'), null);
    assert.equal(classifyLowValue('Cargo.lock.md'), null);
    assert.equal(classifyLowValue('distill/x.js'), null);
    assert.equal(classifyLowValue('buildings/sketch.js'), null);
    assert.equal(classifyLowValue('myvendor/utils.js'), null);
  });

  it('returns null for normal source files', () => {
    assert.equal(classifyLowValue('src/index.ts'), null);
    assert.equal(classifyLowValue('lib/utils.mjs'), null);
    assert.equal(classifyLowValue('tests/test.js'), null);
  });
});

// ── parseNumstatZ ──

describe('parseNumstatZ', () => {
  it('parses normal files', () => {
    const buf = '12\t5\tsrc/main.js\x00';
    const result = parseNumstatZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'src/main.js');
    assert.equal(result[0].added, 12);
    assert.equal(result[0].deleted, 5);
    assert.equal(result[0].binary, false);
    assert.equal(result[0].renamedFrom, null);
  });

  it('parses binary files (dash entries)', () => {
    const buf = '-\t-\tassets/icon.png\x00';
    const result = parseNumstatZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'assets/icon.png');
    assert.equal(result[0].added, null);
    assert.equal(result[0].deleted, null);
    assert.equal(result[0].binary, true);
  });

  it('parses renamed files (real git -z: empty header path + two parts)', () => {
    // Real `git diff --numstat -z -M` rename: header `added\tdeleted\t` (empty path),
    // then two separate NUL-terminated parts: old path, new path.
    const buf = '5\t3\t\x00old/name.js\x00new/name.js\x00';
    const result = parseNumstatZ(buf);
    assert.equal(result.length, 1); // single entry, not two
    assert.equal(result[0].path, 'new/name.js'); // NEW path, not old
    assert.equal(result[0].added, 5);
    assert.equal(result[0].deleted, 3);
    assert.equal(result[0].binary, false);
    assert.equal(result[0].renamedFrom, 'old/name.js');
  });

  it('parses R100 rename with zero churn (real git -z format)', () => {
    const buf = '0\t0\t\x00old/path.js\x00new/path.js\x00';
    const result = parseNumstatZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'new/path.js');
    assert.equal(result[0].renamedFrom, 'old/path.js');
    assert.equal(result[0].added, 0);
    assert.equal(result[0].deleted, 0);
  });

  it('parses multiple entries (incl. real-format rename)', () => {
    const buf = '10\t2\tsrc/a.js\x0030\t5\tsrc/b.js\x000\t0\t\x00src/old.js\x00src/new.js\x00';
    const result = parseNumstatZ(buf);
    assert.equal(result.length, 3);
    assert.equal(result[0].path, 'src/a.js');
    assert.equal(result[1].path, 'src/b.js');
    assert.equal(result[2].path, 'src/new.js');
    assert.equal(result[2].renamedFrom, 'src/old.js');
  });
});

// ── parseNameStatusZ ──

describe('parseNameStatusZ', () => {
  it('parses added/modified/deleted status', () => {
    const buf = 'A\x00src/new.js\x00M\x00src/changed.js\x00D\x00src/removed.js\x00';
    const result = parseNameStatusZ(buf);
    assert.equal(result.length, 3);
    assert.equal(result[0].status, 'A');
    assert.equal(result[0].path, 'src/new.js');
    assert.equal(result[1].status, 'M');
    assert.equal(result[1].path, 'src/changed.js');
    assert.equal(result[2].status, 'D');
    assert.equal(result[2].path, 'src/removed.js');
  });

  it('parses R100 pure rename', () => {
    const buf = 'R100\x00old.js\x00new.js\x00';
    const result = parseNameStatusZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'R100');
    assert.equal(result[0].path, 'new.js');
    assert.equal(result[0].renamedFrom, 'old.js');
  });

  it('parses R85 partial rename', () => {
    const buf = 'R085\x00old/name.js\x00new/name.js\x00';
    const result = parseNameStatusZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'R085');
    assert.equal(result[0].path, 'new/name.js');
    assert.equal(result[0].renamedFrom, 'old/name.js');
  });

  it('parses copy status', () => {
    const buf = 'C080\x00src/orig.js\x00src/copy.js\x00';
    const result = parseNameStatusZ(buf);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'C080');
    assert.equal(result[0].path, 'src/copy.js');
    assert.equal(result[0].renamedFrom, 'src/orig.js');
  });

  it('accepts bare A/M/D and R/C with scores, rejects bogus numbered A/M/D', () => {
    // Bare A/M/D parse; R100/C### parse.
    assert.equal(parseNameStatusZ('A\x00f.js\x00')[0].status, 'A');
    assert.equal(parseNameStatusZ('M\x00f.js\x00')[0].status, 'M');
    assert.equal(parseNameStatusZ('D\x00f.js\x00')[0].status, 'D');
    assert.equal(parseNameStatusZ('R100\x00o.js\x00n.js\x00')[0].status, 'R100');
    assert.equal(parseNameStatusZ('C085\x00o.js\x00n.js\x00')[0].status, 'C085');
    // Bogus numbered A/M/D are not valid git statuses → not parsed as a status record.
    assert.equal(parseNameStatusZ('A5\x00f.js\x00').length, 0);
    assert.equal(parseNameStatusZ('M12\x00f.js\x00').length, 0);
  });

  it('parses mixed statuses', () => {
    const buf = 'M\x00lib/a.mjs\x00A\x00lib/b.mjs\x00R100\x00old/x.js\x00new/x.js\x00';
    const result = parseNameStatusZ(buf);
    assert.equal(result.length, 3);
    assert.equal(result[0].path, 'lib/a.mjs');
    assert.equal(result[1].path, 'lib/b.mjs');
    assert.equal(result[2].path, 'new/x.js');
    assert.equal(result[2].renamedFrom, 'old/x.js');
  });
});

// ── buildManifest ──

describe('buildManifest', () => {
  it('joins numstat + status + hunks by path', () => {
    const numstat = [{ path: 'src/a.js', added: 10, deleted: 2, binary: false, renamedFrom: null }];
    const status = [{ path: 'src/a.js', status: 'M', renamedFrom: null }];
    const hunks = new Map([['src/a.js', ['@@ -1,3 +1,5 @@ fn foo']]]);

    const { entries, excluded } = buildManifest(numstat, status, hunks);
    assert.equal(entries.length, 1);
    assert.equal(excluded.length, 0);
    assert.equal(entries[0].path, 'src/a.js');
    assert.equal(entries[0].status, 'M');
    assert.equal(entries[0].added, 10);
    assert.equal(entries[0].deleted, 2);
    assert.equal(entries[0].hunks.length, 1);
  });

  it('excludes binary files', () => {
    const numstat = [{ path: 'img.png', added: null, deleted: null, binary: true, renamedFrom: null }];
    const status = [{ path: 'img.png', status: 'M', renamedFrom: null }];
    const { entries, excluded } = buildManifest(numstat, status, new Map());
    assert.equal(entries.length, 0);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].reason, 'binary');
  });

  it('excludes R100 pure renames with zero churn', () => {
    const numstat = [{ path: 'new/x.js', added: 0, deleted: 0, binary: false, renamedFrom: 'old/x.js' }];
    const status = [{ path: 'new/x.js', status: 'R100', renamedFrom: 'old/x.js' }];
    const { entries, excluded } = buildManifest(numstat, status, new Map());
    assert.equal(entries.length, 0);
    assert.equal(excluded[0].reason, 'pure rename (R100)');
  });

  it('keeps R85 partial renames (with changes)', () => {
    const numstat = [{ path: 'new/y.js', added: 3, deleted: 1, binary: false, renamedFrom: 'old/y.js' }];
    const status = [{ path: 'new/y.js', status: 'R085', renamedFrom: 'old/y.js' }];
    const { entries } = buildManifest(numstat, status, new Map());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].renamedFrom, 'old/y.js');
    assert.equal(entries[0].status, 'R085');
  });

  it('excludes lockfiles', () => {
    const numstat = [{ path: 'package-lock.json', added: 500, deleted: 300, binary: false, renamedFrom: null }];
    const status = [{ path: 'package-lock.json', status: 'M', renamedFrom: null }];
    const { entries, excluded } = buildManifest(numstat, status, new Map());
    assert.equal(entries.length, 0);
    assert.equal(excluded[0].reason, 'lockfile');
  });

  it('counts excluded by reason', () => {
    const numstat = [
      { path: 'package-lock.json', added: 500, deleted: 300, binary: false, renamedFrom: null },
      { path: 'dist/bundle.js', added: 1, deleted: 1, binary: false, renamedFrom: null },
      { path: 'img.png', added: null, deleted: null, binary: true, renamedFrom: null },
      { path: 'src/main.js', added: 10, deleted: 2, binary: false, renamedFrom: null },
    ];
    const status = [
      { path: 'package-lock.json', status: 'M', renamedFrom: null },
      { path: 'dist/bundle.js', status: 'M', renamedFrom: null },
      { path: 'img.png', status: 'M', renamedFrom: null },
      { path: 'src/main.js', status: 'M', renamedFrom: null },
    ];
    const { entries, excluded } = buildManifest(numstat, status, new Map());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'src/main.js');
    assert.equal(excluded.length, 3);
  });
});

// ── decideMode ──

describe('decideMode', () => {
  it('returns review when diff is under limit', () => {
    assert.equal(decideMode(1000, 40000), 'review');
    assert.equal(decideMode(39999, 40000), 'review');
  });

  it('returns agent when diff exceeds limit', () => {
    assert.equal(decideMode(40001, 40000), 'agent');
    assert.equal(decideMode(100000, 40000), 'agent');
  });

  it('returns empty when diff is zero or negative', () => {
    assert.equal(decideMode(0, 40000), 'empty');
    assert.equal(decideMode(0, 20000), 'empty');
    assert.equal(decideMode(-1, 40000), 'empty');
  });

  it('uses default constant', () => {
    assert.equal(INLINE_DIFF_LIMIT_DEFAULT, 20000);
  });

  it('respects custom limit', () => {
    assert.equal(decideMode(5000, 10000), 'review');
    assert.equal(decideMode(15000, 10000), 'agent');
  });

  it('boundary: exact limit is review', () => {
    assert.equal(decideMode(40000, 40000), 'review');
  });
});

// ── renderManifestText ──

describe('renderManifestText', () => {
  it('renders table with file entries', () => {
    const entries = [
      { path: 'src/main.js', status: 'M', renamedFrom: null, added: 10, deleted: 2, hunks: [] },
    ];
    const text = renderManifestText(entries, { range: 'main...HEAD' });
    assert.ok(text.includes('src/main.js'));
    assert.ok(text.includes('main...HEAD'));
    assert.ok(text.includes('+10/-2'));
  });

  it('shows renamedFrom in status column', () => {
    const entries = [
      { path: 'new/x.js', status: 'R085', renamedFrom: 'old/x.js', added: 3, deleted: 1, hunks: [] },
    ];
    const text = renderManifestText(entries);
    assert.ok(text.includes('R085 (from old/x.js)'));
  });

  it('marks large files (>2000 churn)', () => {
    const entries = [
      { path: 'big.js', status: 'M', renamedFrom: null, added: 1500, deleted: 600, hunks: [] },
    ];
    const text = renderManifestText(entries);
    assert.ok(text.includes('2100 (large)'));
  });

  it('includes hunk headers capped at MAX_HUNKS_PER_FILE', () => {
    const hunks = [];
    for (let i = 1; i <= 15; i++) hunks.push(`@@ -${i},3 +${i},5 @@ fn func${i}`);
    const entries = [
      { path: 'src/file.js', status: 'M', renamedFrom: null, added: 20, deleted: 10, hunks },
    ];
    const text = renderManifestText(entries);
    // 10 hunk headers shown, 5 more indicated
    assert.ok(text.includes('+5 more hunks'));
    // Count '@@' occurrences — should be exactly MAX_HUNKS_PER_FILE (10)
    const hunkCount = (text.match(/@@/g) || []).length;
    assert.equal(hunkCount, MAX_HUNKS_PER_FILE * 2); // each hunk has two @@
  });

  it('truncates long lines to 120 chars', () => {
    const longFn = 'fn ' + 'x'.repeat(200);
    const entries = [
      { path: 'src/file.js', status: 'M', renamedFrom: null, added: 1, deleted: 1,
        hunks: [`@@ -1,3 +1,3 @@ ${longFn}`] },
    ];
    const text = renderManifestText(entries);
    // The hunk line should be truncated
    const hunkLine = text.split('\n').find(l => l.includes('@@'));
    assert.ok(hunkLine.length <= 122); // 120 + 2 leading spaces
  });

  it('respects total text budget', () => {
    // Create many entries with long hunks to exceed budget
    const entries = [];
    for (let i = 0; i < 500; i++) {
      entries.push({
        path: `src/module${i}/component${i}.js`,
        status: 'M', renamedFrom: null, added: 5, deleted: 3,
        hunks: Array.from({ length: 3 }, (_, j) => `@@ -${j * 10},5 +${j * 10},7 @@ fn handler${i}_${j} some context here`),
      });
    }
    const text = renderManifestText(entries);
    assert.ok(text.length <= MANIFEST_TEXT_BUDGET + 5); // small tolerance for "..." suffix
  });

  it('shows +N more when files exceed cap', () => {
    const entries = [];
    for (let i = 0; i < 500; i++) {
      entries.push({
        path: `src/file${i}.js`, status: 'M', renamedFrom: null, added: 1, deleted: 1, hunks: [],
      });
    }
    const text = renderManifestText(entries);
    // Should show entry count but have overflow note
    assert.ok(text.includes('500'));
    assert.ok(text.includes('+200 more')); // 500 - 300 = 200
  });

  it('returns empty string for no entries', () => {
    assert.equal(renderManifestText([]), '');
  });

  it('shows subPath scope when provided', () => {
    const entries = [
      { path: 'src/foo/bar.js', status: 'M', renamedFrom: null, added: 5, deleted: 2, hunks: [] },
    ];
    const text = renderManifestText(entries, { range: 'HEAD', subPath: 'src/foo' });
    assert.ok(text.includes('Scope: `src/foo`'));
  });
});

// ── extractHunkHeaders ──

describe('extractHunkHeaders', () => {
  it('extracts hunk headers grouped by file', () => {
    const diff = [
      'diff --git a/src/main.js b/src/main.js',
      'index abc..def 100644',
      '--- a/src/main.js',
      '+++ b/src/main.js',
      '@@ -1,3 +1,5 @@ function foo() {',
      ' unchanged',
      ' unchanged',
      '+new line',
      '+new line',
      '@@ -10,4 +12,6 @@ function bar() {',
      ' unchanged',
      '+another',
    ].join('\n');
    const map = extractHunkHeaders(diff);
    assert.equal(map.size, 1);
    const hunks = map.get('src/main.js');
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0], '@@ -1,3 +1,5 @@ function foo() {');
    assert.equal(hunks[1], '@@ -10,4 +12,6 @@ function bar() {');
  });

  it('handles multiple files', () => {
    const diff = [
      'diff --git a/a.js b/a.js',
      '@@ -1,1 +1,1 @@',
      'diff --git a/b.js b/b.js',
      '@@ -5,2 +5,3 @@ fn b',
      '@@ -20,1 +20,2 @@ fn c',
    ].join('\n');
    const map = extractHunkHeaders(diff);
    assert.equal(map.size, 2);
    assert.equal(map.get('a.js').length, 1);
    assert.equal(map.get('b.js').length, 2);
  });

  it('handles rename headers (keys by b/ new path, matching buildManifest)', () => {
    const diff = [
      'diff --git a/old/name.js b/new/name.js',
      'similarity index 85%',
      'rename from old/name.js',
      'rename to new/name.js',
      '@@ -1,2 +1,3 @@',
    ].join('\n');
    const map = extractHunkHeaders(diff);
    assert.equal(map.size, 1);
    assert.ok(map.has('new/name.js')); // NEW path so buildManifest lookup hits
    assert.ok(!map.has('old/name.js'));
    assert.equal(map.get('new/name.js').length, 1);
  });

  it('non-rename: a/==b/ unaffected', () => {
    const diff = [
      'diff --git a/src/same.js b/src/same.js',
      '@@ -1,1 +1,1 @@',
    ].join('\n');
    const map = extractHunkHeaders(diff);
    assert.ok(map.has('src/same.js'));
  });

  it('ignores hunk-like patterns outside diff --git context', () => {
    const diff = 'some random text\n@@ -1,1 +1,1 @@\nmore text\n';
    const map = extractHunkHeaders(diff);
    assert.equal(map.size, 0);
  });

  it('handles files with no hunks', () => {
    const diff = 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n';
    const map = extractHunkHeaders(diff);
    assert.equal(map.get('empty.txt').length, 0);
  });

  it('handles empty diff', () => {
    const map = extractHunkHeaders('');
    assert.equal(map.size, 0);
  });
});
