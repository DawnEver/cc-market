// language.test.mjs -- the writers' language policy (.claude/rem.json "language").
// Default "english": text carrying CJK / kana / hangul / full-width forms is refused, naming the
// characters. "unrestricted" writes it. English passes in both modes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';
import { findForeignScript, languagePolicy } from '../scripts/lib.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');
const REMEMBER = path.join(REM, 'scripts', 'remember.js');
// Escapes keep this source file ASCII (dev-lab's CJK guard scans tracked text).
const HAN = '\u4e2d\u6587';          // CJK unified ideographs
const KANA = '\u3072\u3089\u304c\u306a';
const HANGUL = '\ud55c\uae00';
const FULLWIDTH = '\uff21';          // full-width Latin A
const IDEO_PUNCT = '\u3002';         // ideographic full stop
const ORDINARY = 'rotor at 120\u00b0C, \u03bc = 4\u03c0e-7, \u00d7 2 \u2014 fine';

function repo(language) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rem-lang-')));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  if (language) fs.writeFileSync(path.join(root, '.claude', 'rem.json'), JSON.stringify({ language }));
  return root;
}
const env = root => ({ ...process.env, CLAUDE_PROJECT_DIR: root });
const task = (root, ...args) => (grantIfUserVerb(root, args),
  spawnSync(process.execPath, [TASK, ...args], { cwd: root, encoding: 'utf8', env: env(root) }));
const remember = (root, body) => spawnSync(process.execPath,
  [REMEMBER, '--name', 'note', '--type', 'project', '--body', body, '--scope', root],
  { cwd: root, encoding: 'utf8', env: env(root) });
const journal = root => fs.readFileSync(path.join(root, '.claude', 'tasks', 't', 'JOURNAL.md'), 'utf8');
const memFiles = root => fs.readdirSync(path.join(root, '.claude', 'memory'), { recursive: true })
  .filter(f => String(f).endsWith('note.md'));

describe('findForeignScript', () => {
  it('finds every class dev-lab names plus kana and hangul', () => {
    for (const s of [HAN, KANA, HANGUL, FULLWIDTH, IDEO_PUNCT]) assert.ok(findForeignScript(`x ${s} y`).length, s);
  });
  it('planted control: ordinary non-ASCII (degree, Greek, times, em dash) is not foreign', () => {
    assert.deepEqual(findForeignScript(ORDINARY), []);
  });
});

describe('languagePolicy', () => {
  it('defaults to english; reads unrestricted; refuses an unknown value', () => {
    assert.equal(languagePolicy(repo()), 'english');
    assert.equal(languagePolicy(repo('unrestricted')), 'unrestricted');
    assert.throws(() => languagePolicy(repo('klingon')), /language/);
  });
});

for (const [mode, refuses] of [[undefined, true], ['english', true], ['unrestricted', false]]) {
  describe(`mode ${mode ?? '(default)'}`, () => {
    it(`${refuses ? 'refuses' : 'writes'} a CJK journal line; writes an English one`, () => {
      const root = repo(mode);
      assert.equal(task(root, 'open', 't', 'goal').status, 0);
      const ok = task(root, 'log', ORDINARY, '--task', 't');
      assert.equal(ok.status, 0, ok.stderr);
      const r = task(root, 'decide', `use ${HAN} here`, '--task', 't');
      if (refuses) {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /U\+4E2D/);
        assert.match(r.stderr, /English translation/);
        assert.match(r.stderr, /\(user, translated\)/);
        assert.ok(!journal(root).includes(HAN));
      } else {
        assert.equal(r.status, 0, r.stderr);
        assert.ok(journal(root).includes(HAN));
      }
    });
    it(`${refuses ? 'refuses' : 'writes'} a CJK memory body; writes an English one`, () => {
      const root = repo(mode);
      const r = remember(root, `the user said ${KANA}`);
      if (refuses) {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /U\+3072/);
        assert.deepEqual(memFiles(root), []);
        assert.equal(remember(root, ORDINARY).status, 0);
      } else {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(memFiles(root).length, 1);
      }
    });
  });
}
