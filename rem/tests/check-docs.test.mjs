// check-docs.test.mjs — tests for check-docs.js
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'url';
import {
  DOC_PATTERN, SKIP_DIRS,
  collectDocs, crossReference, formatReport, referencedChanges,
} from '../scripts/check-docs.js';

// ── collectDocs ──
describe('collectDocs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'check-docs-test-'));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('finds README.md at root', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('README.md'));
  });

  test('finds AGENTS.md at root', () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('AGENTS.md'));
  });

  test('finds CLAUDE.md at root', () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('CLAUDE.md'));
  });

  test('finds AGENT.md at root', () => {
    writeFileSync(join(tmpDir, 'AGENT.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('AGENT.md'));
  });

  test('finds CHANGELOG.md', () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('CHANGELOG.md'));
  });

  test('finds CONTRIBUTING.md', () => {
    writeFileSync(join(tmpDir, 'CONTRIBUTING.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('CONTRIBUTING.md'));
  });

  test('finds docs at nested levels', () => {
    mkdirSync(join(tmpDir, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(tmpDir, 'sub', 'README.md'), '# test');
    writeFileSync(join(tmpDir, 'sub', 'deep', 'AGENTS.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(docs.includes('sub/README.md'));
    assert.ok(docs.includes('sub/deep/AGENTS.md'));
  });

  test('skips hidden directories', () => {
    mkdirSync(join(tmpDir, '.hidden'), { recursive: true });
    writeFileSync(join(tmpDir, '.hidden', 'README.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(!docs.some(d => d.includes('.hidden')));
  });

  test('skips node_modules', () => {
    mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'README.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(!docs.some(d => d.includes('node_modules')));
  });

  test('skips .git', () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    writeFileSync(join(tmpDir, '.git', 'README.md'), '# test');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(!docs.some(d => d.includes('.git')));
  });

  test('ignores non-doc .md files', () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# notes');
    writeFileSync(join(tmpDir, 'design.md'), '# design');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.ok(!docs.includes('notes.md'));
    assert.ok(!docs.includes('design.md'));
  });

  test('stops at depth 4', () => {
    let d = tmpDir;
    for (let i = 0; i < 6; i++) {
      d = join(d, `level${i}`);
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(d, 'README.md'), '# deep');
    const docs = collectDocs(tmpDir, tmpDir, 0);
    // level5 is depth 5, should not be found
    assert.ok(!docs.some(p => p.includes('level5')));
  });

  test('returns empty for empty directory', () => {
    const docs = collectDocs(tmpDir, tmpDir, 0);
    assert.equal(docs.length, 0);
  });

  test('DOC_PATTERN matches expected names', () => {
    assert.ok(DOC_PATTERN.test('README.md'));
    assert.ok(DOC_PATTERN.test('CLAUDE.md'));
    assert.ok(DOC_PATTERN.test('AGENTS.md'));
    assert.ok(DOC_PATTERN.test('AGENT.md'));
    assert.ok(DOC_PATTERN.test('CHANGELOG.md'));
    assert.ok(DOC_PATTERN.test('CONTRIBUTING.md'));
    assert.ok(DOC_PATTERN.test('README_zh.md'));
    assert.ok(!DOC_PATTERN.test('notes.md'));
    assert.ok(!DOC_PATTERN.test('random.txt'));
  });

  test('SKIP_DIRS includes expected entries', () => {
    for (const d of ['node_modules', '.git', '.claude', 'dist', 'build', '__pycache__', '.venv', 'venv']) {
      assert.ok(SKIP_DIRS.has(d), `expected ${d} in SKIP_DIRS`);
    }
  });
});

// ── crossReference ──
describe('crossReference', () => {
  test('all docs modified — no stale', () => {
    const result = crossReference(
      ['README.md', 'AGENTS.md'],
      ['README.md', 'AGENTS.md', 'src/index.ts'],
    );
    assert.deepEqual(result.modifiedDocs, ['README.md', 'AGENTS.md']);
    assert.deepEqual(result.staleDocs, []);
    assert.equal(result.needsReview, false);
  });

  test('only docs that REFERENCE a changed file are candidates', () => {
    const docs = { 'README.md': 'see src/index.ts for details', 'AGENTS.md': 'nothing relevant here' };
    const result = crossReference(['README.md', 'AGENTS.md'], ['src/index.ts'], (d) => docs[d]);
    assert.deepEqual(result.modifiedDocs, []);
    assert.deepEqual(result.staleDocs, ['README.md']);
    assert.deepEqual(result.staleBecause['README.md'], ['src/index.ts']);
    assert.equal(result.needsReview, true);
  });

  // Without a reader there is no evidence either way. Reporting everything is the behaviour
  // that made this check noise; reporting nothing is honest.
  test('with no reader, nothing is claimed either way', () => {
    const result = crossReference(['README.md', 'AGENTS.md'], ['src/index.ts']);
    assert.deepEqual(result.staleDocs, []);
    assert.equal(result.needsReview, false);
  });

  test('a filename mention counts, but only as a standalone token', () => {
    assert.deepEqual(referencedChanges('run node scripts/check-docs.js', ['rem/scripts/check-docs.js']),
      ['rem/scripts/check-docs.js']);
    assert.deepEqual(referencedChanges('see bar-check-docs.js', ['rem/scripts/check-docs.js']), []);
    assert.deepEqual(referencedChanges('nothing here', ['rem/scripts/check-docs.js']), []);
  });

  test('partial — one edited, one referencing a change', () => {
    const docs = { 'AGENTS.md': 'documents src/index.ts' };
    const result = crossReference(
      ['README.md', 'AGENTS.md'],
      ['README.md', 'src/index.ts'],
      (d) => docs[d] ?? '',
    );
    assert.deepEqual(result.modifiedDocs, ['README.md']);
    assert.deepEqual(result.staleDocs, ['AGENTS.md']);
    assert.equal(result.needsReview, true);
  });

  test('no changes — all docs clean', () => {
    const result = crossReference(
      ['README.md', 'AGENTS.md'],
      [],
    );
    assert.deepEqual(result.modifiedDocs, []);
    assert.deepEqual(result.staleDocs, [], 'no changes means nothing to review');
    assert.equal(result.needsReview, false);
  });

  test('only doc files changed — no stale', () => {
    const result = crossReference(
      ['README.md'],
      ['README.md'],
    );
    assert.deepEqual(result.modifiedDocs, ['README.md']);
    assert.deepEqual(result.staleDocs, []);
    assert.equal(result.needsReview, false);
  });

  test('no doc files at all', () => {
    const result = crossReference(
      [],
      ['src/index.ts'],
    );
    assert.deepEqual(result.modifiedDocs, []);
    assert.deepEqual(result.staleDocs, []);
    assert.equal(result.needsReview, false);
  });

  test('dedup works — same file in changedFiles', () => {
    const result = crossReference(
      ['README.md'],
      ['README.md', 'README.md', 'src/a.ts'],
    );
    assert.deepEqual(result.modifiedDocs, ['README.md']);
    assert.deepEqual(result.staleDocs, []);
    assert.equal(result.needsReview, false);
  });
});

// ── formatReport ──
describe('formatReport', () => {
  test('no changes — clean report', () => {
    // With nothing changed the new criterion yields no candidates at all, so the fixture
    // no longer pairs "no changes" with a stale doc.
    const report = formatReport({
      changedFiles: [],
      docFiles: ['README.md'],
      modifiedDocs: [],
      staleDocs: [],
      needsReview: false,
    });
    assert.ok(report.includes('No uncommitted changes'));
    assert.ok(report.includes('working tree clean'));
    assert.ok(!report.includes('references'));
  });

  // Naming the file it references is what makes the line actionable; a bare
  // "may be stale" on every doc is what made the whole check ignorable.
  test('stale docs — the report names what each one references', () => {
    const report = formatReport({
      changedFiles: ['src/a.ts'],
      docFiles: ['README.md'],
      modifiedDocs: [],
      staleDocs: ['README.md'],
      staleBecause: { 'README.md': ['src/a.ts'] },
      needsReview: true,
    });
    assert.ok(report.includes('references src/a.ts'));
    assert.ok(report.includes('not all of them'));
  });

  test('all docs updated', () => {
    const report = formatReport({
      changedFiles: ['src/a.ts', 'README.md'],
      docFiles: ['README.md'],
      modifiedDocs: ['README.md'],
      staleDocs: [],
      needsReview: false,
    });
    assert.ok(report.includes('✓ updated'));
  });
});

// ── CLI integration (spawn subprocess) ──
describe('CLI', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'check-docs-repo-'));
    execFileSync('git', ['init'], { cwd: repoDir, timeout: 5000 });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, timeout: 2000 });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  function runCheckDocs(cwd) {
    const scriptPath = fileURLToPath(import.meta.url).replace(/\\/g, '/').replace(
      /tests\/check-docs\.test\.mjs$/, 'scripts/check-docs.js',
    );
    try {
      const out = execFileSync('node', [scriptPath], { cwd, timeout: 5000, encoding: 'utf8' });
      return { exitCode: 0, stdout: out };
    } catch (e) {
      return { exitCode: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }

  test('clean repo — exit 0', () => {
    writeFileSync(join(repoDir, 'README.md'), '# test');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, timeout: 2000 });
    const result = runCheckDocs(repoDir);
    assert.equal(result.exitCode, 0);
  });

  test('a doc that references the change — exit 1', () => {
    writeFileSync(join(repoDir, 'README.md'), '# test\n\nSee src/index.js for details.');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// change');
    execFileSync('git', ['add', 'README.md', 'src/index.js'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, timeout: 2000 });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// modified');
    const result = runCheckDocs(repoDir);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('references src/index.js'),
      'the report must name what the doc references, not just flag it');
  });

  // The behaviour this change is about: a doc that says nothing about the changed file is
  // not a candidate. Before, every untouched doc was flagged on any change, which is how a
  // dozen standing warnings become invisible.
  test('a doc that does not reference the change — exit 0', () => {
    writeFileSync(join(repoDir, 'README.md'), '# test\n\nNothing about source files here.');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// change');
    execFileSync('git', ['add', 'README.md', 'src/index.js'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, timeout: 2000 });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// modified');
    const result = runCheckDocs(repoDir);
    assert.equal(result.exitCode, 0);
    // Match the marker, not the bare word — the summary line legitimately says
    // "No doc references anything that changed".
    assert.ok(!result.stdout.includes('— references'),
      'an unrelated doc must not be flagged');
  });

  test('uncommitted change + doc also changed — exit 0', () => {
    writeFileSync(join(repoDir, 'README.md'), '# test');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, timeout: 2000 });
    writeFileSync(join(repoDir, 'README.md'), '# updated');
    const result = runCheckDocs(repoDir);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('✓ updated'));
  });

  test('no doc files — exit 0', () => {
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// code');
    execFileSync('git', ['add', 'src/index.js'], { cwd: repoDir, timeout: 2000 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, timeout: 2000 });
    writeFileSync(join(repoDir, 'src', 'index.js'), '// modified');
    const result = runCheckDocs(repoDir);
    assert.equal(result.exitCode, 0);
  });
});
