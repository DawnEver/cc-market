// The family principles page is a RENDER of dev_lab.dev.principles (the one source), never hand-edited.
// Re-render: python -c "import pathlib; from dev_lab.dev.principles import write_page; write_page(pathlib.Path('.'))"
// The drift check needs a Python that imports dev_lab (DEV_LAB_PYTHON, else `python`); without one it skips, saying so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PAGE = new URL('../.claude/rules/principles.md', import.meta.url);
const lf = (s) => s.replace(/\r\n/g, '\n');

test('the committed principles page equals dev_lab.dev.principles.render()', (t) => {
  const page = lf(readFileSync(PAGE, 'utf8'));
  assert.match(page, /^# Principles -- family policy, rendered from dev_lab\.dev\.principles; edit there\n/);
  const run = spawnSync(process.env.DEV_LAB_PYTHON || 'python',
    ['-c', 'import sys; from dev_lab.dev.principles import render; sys.stdout.write(render())'],
    { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) return t.skip('no Python importing dev_lab: set DEV_LAB_PYTHON to check drift');
  assert.equal(page, lf(run.stdout), 'principles.md drifted from dev_lab.dev.principles; re-render it');
});
