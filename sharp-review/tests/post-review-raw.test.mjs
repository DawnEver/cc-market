/**
 * Integration tests for `post-review.js --raw`: the host-agnostic entry where raw
 * per-reviewer findings are merged + rendered + written in one step (the path the
 * worker subagent and Codex use). Run:
 *   node --test cc-market/sharp-review/tests/post-review-raw.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POST_REVIEW = join(__dirname, '..', 'scripts', 'post-review.js');

function runRaw(projectDir, raw, date = '2026-06-21') {
  const rawFile = join(projectDir, 'raw.json');
  writeFileSync(rawFile, JSON.stringify(raw), 'utf8');
  // stamp-memory may warn if rem isn't resolvable; it's caught non-fatally, so exit 0 stands.
  execFileSync('node', [POST_REVIEW, '--date', date, '--raw', rawFile], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  return join(projectDir, '.claude', 'memory', '2026', '06', '21', 'sharp-review.md');
}

describe('post-review.js --raw', () => {
  test('merges raw reviewer findings → writes memory entry with frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-raw-'));
    try {
      const memFile = runRaw(dir, {
        reviewers: [
          { key: 'A', name: 'Codex' },
          { key: 'B', name: 'DeepSeek' },
          { key: 'C', name: 'Opus' },
        ],
        active: [{ key: 'A', name: 'Codex' }, { key: 'B', name: 'DeepSeek' }],
        profileLabel: 'diff review',
        rawResults: [
          { findings: [{ file: 'a.js', summary: 'leak', severity: 'HIGH', category: 'Bug' }] },
          { findings: [{ file: 'a.js', summary: 'leak', severity: 'HIGH', category: 'Bug' }] },
        ],
      });
      assert.ok(existsSync(memFile), 'memory file should be written');
      const content = readFileSync(memFile, 'utf8');
      assert.match(content, /^---\n/); // rem frontmatter
      assert.match(content, /high-confidence/); // both reviewers agreed → deduped to 1 high-conf
      assert.match(content, /\[SR-20260621-001\] \[HIGH\] a\.js — leak/);
      assert.match(content, /- Reviewer C \(Opus\): skipped/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tolerates a failed reviewer (null rawResult)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-raw-'));
    try {
      const memFile = runRaw(dir, {
        reviewers: [{ key: 'A', name: 'Codex' }, { key: 'B', name: 'DeepSeek' }],
        active: [{ key: 'A', name: 'Codex' }, { key: 'B', name: 'DeepSeek' }],
        rawResults: [
          { findings: [{ file: 'b.js', summary: 'solo', severity: 'LOW', category: 'Bug' }] },
          null,
        ],
      });
      const content = readFileSync(memFile, 'utf8');
      assert.match(content, /single-reviewer/);
      assert.match(content, /- Reviewer B \(DeepSeek\): FAILED/);
      assert.match(content, /Warning: only 1\/2 reviewers succeeded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
