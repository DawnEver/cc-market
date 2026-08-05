import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findMainTex, parseTexcount, formatTable, targetLine, fmt, tokenize,
} from '../scripts/word-count.mjs';
import {
  FIXTURE, EXPECTED_SECTIONS, EXPECTED_TOTAL,
  CHAPTER_FIXTURE, EXPECTED_CHAPTER_SECTIONS, EXPECTED_CHAPTER_TOTAL,
} from './fixture.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/word-count.mjs', import.meta.url));
const STUB = fileURLToPath(new URL('./stub-texcount.mjs', import.meta.url));

/** Temp dir with an empty main.tex, cleaned up after the test. */
function tmpProject() {
  const dir = tmpBare();
  writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n');
  return dir;
}

/** Temp dir with nothing in it, cleaned up after the test. */
function tmpBare() {
  return mkdtempSync(join(tmpdir(), 'cc-latex-'));
}

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('parseTexcount: per-section sums and grand total from pinned output', () => {
  const { sections, total } = parseTexcount(FIXTURE);
  assert.deepEqual(sections, EXPECTED_SECTIONS);
  assert.equal(total, EXPECTED_TOTAL);
});

test('parseTexcount: handles CRLF line endings (Windows texcount)', () => {
  const { sections, total } = parseTexcount(FIXTURE.replace(/\n/g, '\r\n'));
  assert.deepEqual(sections, EXPECTED_SECTIONS);
  assert.equal(total, EXPECTED_TOTAL);
});

test('parseTexcount: chapter-style docs fall back to per-file breakdown', () => {
  const { sections, total } = parseTexcount(CHAPTER_FIXTURE);
  assert.deepEqual(sections, EXPECTED_CHAPTER_SECTIONS);
  assert.equal(total, EXPECTED_CHAPTER_TOTAL);
});

test('parseTexcount: fails clearly when no Sum count is present', () => {
  assert.throws(() => parseTexcount('File: main.tex\nWords in text: 3\n'), /Sum count/);
});

test('findMainTex: main.tex at the project root', () => {
  const dir = tmpProject();
  try { assert.deepEqual(findMainTex(dir), { dir, main: 'main.tex' }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findMainTex: single depth-1 subdirectory', () => {
  const dir = tmpBare();
  const sub = join(dir, 'chapter_1');
  try {
    mkdirSync(sub);
    writeFileSync(join(sub, 'main.tex'), '');
    assert.deepEqual(findMainTex(dir), { dir: sub, main: 'main.tex' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findMainTex: ambiguous candidates error lists them', () => {
  const dir = tmpBare();
  try {
    for (const d of ['a', 'b']) {
      mkdirSync(join(dir, d));
      writeFileSync(join(dir, d, 'main.tex'), '');
    }
    assert.throws(() => findMainTex(dir), /multiple main\.tex.*a.*b/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findMainTex: missing main.tex errors', () => {
  const dir = tmpBare();
  try { assert.throws(() => findMainTex(dir), /no main\.tex found/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findMainTex: explicit file path argument', () => {
  const dir = tmpProject();
  try {
    assert.deepEqual(findMainTex(join(dir, 'main.tex')), { dir, main: 'main.tex' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E2E: table output with sections, total and target line', () => {
  const dir = tmpProject();
  try {
    const r = run(['--texcount', `node "${STUB}"`, '--target', '8000'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Abstract\s+8/);
    assert.match(r.stdout, /Aim\s+9/);
    assert.match(r.stdout, /Total \(excl\. references\)\s+31/);
    assert.match(r.stdout, /Target: 31 \/ 8,000 \(0%\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E2E: --json emits machine-readable shape', () => {
  const dir = tmpProject();
  try {
    const r = run(['--json', '--texcount', `node "${STUB}"`], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.main, 'main.tex');
    assert.equal(out.total, 31);
    assert.deepEqual(out.sections, EXPECTED_SECTIONS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E2E: missing texcount binary exits 1 with an install hint', () => {
  const dir = tmpProject();
  try {
    const r = run(['--texcount', 'cc-latex-no-such-binary-xyz'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /texcount not found.*tlmgr install texcount/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E2E: no main.tex exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-latex-'));
  try {
    const r = run([], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no main\.tex found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tokenize: honors double quotes (paths with spaces)', () => {
  assert.deepEqual(tokenize('texcount'), ['texcount']);
  assert.deepEqual(tokenize('node "C:\\path with spaces\\stub.mjs"'), ['node', 'C:\\path with spaces\\stub.mjs']);
  assert.deepEqual(tokenize('"a b" c'), ['a b', 'c']);
});

test('formatTable and targetLine', () => {
  const table = formatTable(EXPECTED_SECTIONS, EXPECTED_TOTAL);
  assert.match(table, /Abstract\s+8/);
  assert.match(table, /Total \(excl\. references\)\s+31/);
  assert.equal(targetLine(1064, 5000), 'Target: 1,064 / 5,000 (21%)');
  assert.equal(fmt(8000), '8,000');
});
