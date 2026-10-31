// provenance.test.mjs — the derived index lives outside rules/ and is byte-identical
// wherever it is derived; a newer entry carries all provenance (merged_from,
// supersedes, corrects) and an old entry is never edited.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listEntries, hiddenEntries, correctionsOf, renderIndex, rebuildIndex, indexFilePath,
} from '../scripts/lib.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');

function scope(prefix = 'rem-prov-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
function put(root, rel, text) {
  const file = path.join(root, '.claude', 'memory', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const entryText = (name, extra = '', body = `body of ${name}`) =>
  `---\nname: ${name}\ndescription: about ${name}\n${extra}metadata:\n  type: project\n---\n\n${body}\n`;
function run(root, script, ...args) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}

describe('the derived index', () => {
  it('lives outside .claude/rules/, so nothing generated loads as a rule', () => {
    const root = scope();
    put(root, '2026/01/01/a.md', entryText('a'));
    rebuildIndex(root);
    assert.equal(indexFilePath(root), path.join(root, '.claude', 'memory-index.md'));
    assert.ok(fs.existsSync(indexFilePath(root)));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'rules')));
  });

  it('two machines deriving the same tree write the same bytes', () => {
    // Machine A: LF files written oldest first. Machine B: CRLF checkout, written in
    // reverse order, different mtimes, a different cwd and a child scope found later.
    const files = {
      '2026/01/02/Zeta.md': entryText('Zeta'),
      '2026/01/02/alpha.md': entryText('alpha'),
      '2026/01/02/_under.md': entryText('_under'),
      '2025/12/31/old.md': entryText('old', 'supersedes: 2025/12/30/older.md\n'),
      '2025/12/30/older.md': entryText('older'),
      '2026/01/03/fix.md': entryText('fix', 'corrects: 2026/01/02/alpha.md\n'),
    };
    const a = scope('rem-a-'), b = scope('rem-b-');
    for (const [rel, text] of Object.entries(files)) put(a, rel, text);
    for (const [rel, text] of Object.entries(files).reverse()) put(b, rel, text.replace(/\n/g, '\r\n'));
    for (const root of [a, b]) {
      fs.mkdirSync(path.join(root, 'pkg', '.claude', 'memory'), { recursive: true });
      fs.mkdirSync(path.join(root, 'Lib', '.claude', 'memory'), { recursive: true });
    }
    const past = new Date('2020-01-01');
    for (const f of fs.readdirSync(path.join(b, '.claude', 'memory'), { recursive: true })) {
      fs.utimesSync(path.join(b, '.claude', 'memory', f), past, past);
    }
    const cwd = process.cwd();
    const ia = renderIndex(a);
    process.chdir(b);
    try { assert.equal(renderIndex(b), ia); } finally { process.chdir(cwd); }
    assert.ok(!ia.includes(a) && !ia.includes(os.tmpdir()), 'no machine path in the index');
    assert.doesNotMatch(ia, /accessed|count:|\r/);
    // Byte order, not locale order: '_' < 'a' < 'z', and 'Z' < '_'.
    assert.ok(ia.indexOf('Zeta.md') < ia.indexOf('_under.md'));
    assert.ok(ia.indexOf('_under.md') < ia.indexOf('alpha.md'));
    assert.ok(ia.indexOf('Lib/') < ia.indexOf('pkg/'));
  });

  it('lists every visible entry, hides superseded and merged ones, flags corrected ones', () => {
    const root = scope();
    for (let i = 1; i <= 30; i++) put(root, `2026/02/${String(i).padStart(2, '0')}/e${i}.md`, entryText(`e${i}`));
    put(root, '2026/03/01/m.md', entryText('m', 'merged_from: 2026/02/01/e1.md\n'));
    put(root, '2026/03/02/s.md', entryText('s', 'supersedes:\n  - 2026/02/02/e2.md\n'));
    put(root, '2026/03/03/c.md', entryText('c', 'corrects: 2026/02/03/e3.md\n'));
    const text = renderIndex(root);
    assert.match(text, /e30\.md/);
    assert.doesNotMatch(text, /\/e1\.md\)/);
    assert.doesNotMatch(text, /\/e2\.md\)/);
    assert.match(text, /^- \[2026-02-03 e3\]\(memory\/2026\/02\/03\/e3\.md\) — about e3 \(corrected by memory\/2026\/03\/03\/c\.md\)$/m);
    assert.match(text, /\(31 visible of 33\)/);
  });
});

describe('provenance fields', () => {
  it('supersedes hides like merged_from; corrects keeps the old entry visible', () => {
    const root = scope();
    put(root, '2026/01/01/a.md', entryText('a'));
    put(root, '2026/01/01/b.md', entryText('b'));
    put(root, '2026/01/02/n.md', entryText('n', 'supersedes: 2026/01/01/a.md\ncorrects: 2026/01/01/b.md\n'));
    const entries = listEntries(root);
    assert.deepEqual([...hiddenEntries(entries)], [['2026/01/01/a.md', '2026/01/02/n.md']]);
    assert.deepEqual([...correctionsOf(entries)], [['2026/01/01/b.md', ['2026/01/02/n.md']]]);
  });
});

describe('an old entry is never edited', () => {
  it('remember.js --corrects writes a new entry naming the old one, which stays byte-identical', () => {
    const root = scope();
    const old = put(root, '2026/01/01/rate.md', entryText('rate', '', 'The rate is 5.'));
    const before = fs.readFileSync(old, 'utf8');
    const r = run(root, 'remember.js', '--name', 'rate-corrected', '--type', 'project',
      '--body', 'The rate is 7, not 5.', '--corrects', '2026/01/01/rate.md');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(old, 'utf8'), before);
    const created = fs.readFileSync(path.join(root, '.claude', 'memory', today, 'rate-corrected.md'), 'utf8');
    assert.match(created, /^corrects:\n {2}- 2026\/01\/01\/rate\.md$/m);
  });

  it('remember.js --supersedes hides the old entry and leaves its file untouched', () => {
    const root = scope();
    const old = put(root, '2026/01/01/rule.md', entryText('rule'));
    const before = fs.readFileSync(old, 'utf8');
    assert.equal(run(root, 'remember.js', '--name', 'rule-v2', '--type', 'project', '--body', 'v2',
      '--supersedes', '2026/01/01/rule.md').status, 0);
    assert.equal(fs.readFileSync(old, 'utf8'), before);
    assert.doesNotMatch(fs.readFileSync(indexFilePath(root), 'utf8'), /2026\/01\/01\/rule\.md/);
  });

  it('remember.js refuses a provenance target that is not an entry of the scope', () => {
    const root = scope();
    const r = run(root, 'remember.js', '--name', 'x', '--type', 'project', '--body', 'b', '--corrects', '2026/01/01/nope.md');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an entry/);
  });

  it('remember.js never rewrites an existing file: a different body under the same name is refused', () => {
    const root = scope();
    assert.equal(run(root, 'remember.js', '--name', 'n', '--type', 'project', '--body', 'one').status, 0);
    const file = path.join(root, '.claude', 'memory', today, 'n.md');
    const before = fs.readFileSync(file, 'utf8');
    for (const extra of [[], ['--update']]) {
      const r = run(root, 'remember.js', '--name', 'n', '--type', 'project', '--body', 'two', ...extra);
      assert.equal(r.status, 1);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('merge-memory.js writes a NEW entry naming every source; each source stays byte-identical', () => {
    const root = scope();
    const a = put(root, '2026/01/01/a.md', entryText('a', '', 'Measured 7.8499932 vs 7.85.'));
    const b = put(root, '2026/01/02/b.md', entryText('b', '', '> "quote kept"'));
    const before = [a, b].map(f => fs.readFileSync(f, 'utf8'));
    const r = run(root, 'merge-memory.js', '--name', 'ab', '--from', '2026/01/01/a.md,2026/01/02/b.md');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([a, b].map(f => fs.readFileSync(f, 'utf8')), before);
    const merged = fs.readFileSync(path.join(root, '.claude', 'memory', today, 'ab.md'), 'utf8');
    assert.match(merged, /merged_from:\n {2}- 2026\/01\/01\/a\.md\n {2}- 2026\/01\/02\/b\.md\n/);
    assert.match(merged, /Measured 7\.8499932 vs 7\.85\./);
    assert.match(merged, /> "quote kept"/);
    const index = fs.readFileSync(indexFilePath(root), 'utf8');
    assert.match(index, /\/ab\.md\)/);
    assert.doesNotMatch(index, /\/a\.md\)|\/b\.md\)/);
  });
});

describe('recall carries corrections', () => {
  it('a recalled entry that was corrected brings its correction along', () => {
    const root = scope();
    put(root, '2026/01/01/zebra-rate.md', entryText('zebra-rate', '', 'The zebra rate is 5.'));
    put(root, '2026/01/05/rate-fix.md', entryText('rate-fix', 'corrects: 2026/01/01/zebra-rate.md\n', 'It is 7.'));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'recall.js')], {
      input: JSON.stringify({ prompt: 'zebra rate', cwd: root }), encoding: 'utf8', cwd: root,
    });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /The zebra rate is 5\./);
    assert.match(ctx, /corrected by 2026\/01\/05\/rate-fix\.md/);
    assert.match(ctx, /It is 7\./);
  });
});
