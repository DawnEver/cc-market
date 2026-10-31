// lifecycle.test.mjs — the tree is the only source of truth: entries, the derived
// index, visibility derived from `merged_from`, reads that never write, and no
// code path that deletes a memory file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseMergedFrom, listEntries, hiddenEntries, renderIndex, rebuildIndex, HOT_MAX,
} from '../scripts/lib.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const RECALL = path.join(REM, 'scripts', 'recall.js');

function scope() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-life-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}
function entry(root, rel, { name, description = 'd', type = 'project', extra = '' } = {}) {
  const file = path.join(root, '.claude', 'memory', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const n = name || path.basename(rel, '.md');
  fs.writeFileSync(file, `---\nname: ${n}\ndescription: ${description}\n${extra}metadata:\n  type: ${type}\n---\n\nbody of ${n}\n`);
  return file;
}
function snapshot(root) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out[path.relative(root, f)] = fs.statSync(f).mtimeMs;
    }
  })(root);
  return out;
}
function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'shared') out.push(...sources(f)); }
    else if (/\.(m?js)$/.test(e.name)) out.push(f);
  }
  return out;
}

describe('parseMergedFrom', () => {
  it('reads inline and block lists and normalizes to scope-relative paths', () => {
    assert.deepEqual(parseMergedFrom('---\nname: a\nmerged_from: .claude/memory/2026/06/14/x.md, 2026/06/15/y.md\n---\n'),
      ['2026/06/14/x.md', '2026/06/15/y.md']);
    assert.deepEqual(parseMergedFrom("---\nmerged_from:\n  - '2026/01/02/a.md'\n  - src/m/.claude/memory/2026/01/03/b.md\nname: z\n---\n"),
      ['2026/01/02/a.md', '2026/01/03/b.md']);
    assert.deepEqual(parseMergedFrom('---\nname: a\n---\nmerged_from: 2026/01/01/body.md\n'), []);
  });
});

describe('listEntries', () => {
  it('lists dated entries newest first and skips undated files', () => {
    const root = scope();
    entry(root, '2026/01/01/old.md');
    entry(root, '2026/03/01/new.md', { type: 'feedback', description: 'the new one' });
    entry(root, 'loose.md');
    const got = listEntries(root);
    assert.deepEqual(got.map(e => e.path), ['2026/03/01/new.md', '2026/01/01/old.md']);
    assert.equal(got[0].date, '2026-03-01');
    assert.equal(got[0].type, 'feedback');
    assert.equal(got[0].description, 'the new one');
  });
});

describe('visibility', () => {
  it('hides an entry a newer entry names, never the namer itself, and keeps the file', () => {
    const root = scope();
    const old = entry(root, '2026/01/01/fact.md');
    entry(root, '2026/02/01/fact.md', { extra: 'merged_from:\n  - 2026/01/01/fact.md\n  - 2026/02/01/fact.md\n  - 2025/12/31/gone.md\n' });
    const hidden = hiddenEntries(listEntries(root));
    assert.deepEqual([...hidden], [['2026/01/01/fact.md', '2026/02/01/fact.md']]);
    rebuildIndex(root);
    assert.ok(fs.existsSync(old));
  });
});

describe('derived index', () => {
  it('carries no access bookkeeping, hides named entries, keeps user/feedback past the hot window', () => {
    const root = scope();
    entry(root, '2025/01/01/pref.md', { type: 'user' });
    for (let i = 1; i <= HOT_MAX + 3; i++) entry(root, `2026/02/${String(i).padStart(2, '0')}/e${i}.md`);
    entry(root, '2026/03/01/sup.md', { extra: 'merged_from: 2026/02/18/e18.md\n' });
    const text = renderIndex(root);
    assert.doesNotMatch(text, /accessed|count:|tier/);
    assert.match(text, /2025\/01\/01\/pref\.md/);
    assert.doesNotMatch(text, /e18\.md\)/);
    assert.doesNotMatch(text, /2026\/02\/01\/e1\.md/);
    assert.match(text, /^- \[2026-03-01 sup\]\(\.\.\/memory\/2026\/03\/01\/sup\.md\) — d$/m);
  });

  it('is written only when its bytes change, so concurrent sessions converge', () => {
    const root = scope();
    entry(root, '2026/01/01/a.md');
    const file = path.join(root, '.claude', 'rules', 'MEMORY.md');
    assert.equal(rebuildIndex(root), true);
    const first = fs.statSync(file).mtimeMs;
    assert.equal(rebuildIndex(root), false);
    assert.equal(fs.statSync(file).mtimeMs, first);
    entry(root, '2026/01/02/b.md');
    assert.equal(rebuildIndex(root), true);
  });
});

describe('reading never writes', () => {
  it('a recall that injects an entry leaves the project tree byte- and mtime-identical', () => {
    const root = scope();
    entry(root, '2026/01/01/zebra-migration.md', { description: 'zebra migration notes' });
    fs.writeFileSync(path.join(root, '.claude', '.rem-state.json'), '{}');
    const before = snapshot(root);
    const r = spawnSync(process.execPath, [RECALL], {
      input: JSON.stringify({ prompt: 'zebra migration', cwd: root }), encoding: 'utf8', cwd: root,
    });
    assert.match(r.stdout, /zebra-migration/);
    assert.deepEqual(snapshot(root), before);
  });

  it('no SessionStart hook writes the memory tree or an index', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REM, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const commands = (hooks.SessionStart || []).flatMap(g => g.hooks.map(h => h.command));
    assert.deepEqual(commands.filter(c => /prune|index|stamp|touch/.test(c)), []);
  });
});

describe('no memory entry is ever deleted', () => {
  // Planted control: the scan must see a deleter when one is present.
  const DELETES = /\b(?:unlinkSync|rmSync|rmdirSync|unlink|rm|rmdir)\s*\(|['"]rm['"]\s*[,\]]|\bgit rm\b/;

  it('the scan catches a planted deleter', () => {
    assert.match('fs.unlinkSync(join(memDir, p));', DELETES);
    assert.match("execFileSync('git', ['rm', p]);", DELETES);
    assert.match('fs.rmSync(dir, { recursive: true });', DELETES);
  });

  it('no rem script, hook or migration calls a file-removing API', () => {
    const offenders = sources(REM)
      .filter(f => DELETES.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(REM, f).replace(/\\/g, '/'));
    assert.deepEqual(offenders, []);
  });
});
