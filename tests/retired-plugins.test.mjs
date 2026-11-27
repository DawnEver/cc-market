// RETIRED PLUGINS (user ruling 2026-11-24): cc-market keeps only cc-academia. A retired plugin's code stays,
// but every surface a person reads says it is no longer updated. Each check runs on a planted control first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RETIRED = ['rem', 'sharp-review', 'evolve', 'watch', 'cc-latex', 'traceme', 'fabric'];
const PREFIX = 'RETIRED (no longer updated, 2026-11-24)';

const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const unmarkedEntries = (m) => m.plugins.filter((p) => RETIRED.includes(p.name) && !p.description.startsWith(PREFIX)).map((p) => p.name);
const readme = (name) => join(root, name, 'README.md');
const unmarkedReadme = (text) => !text.split('\n').slice(0, 5).some((l) => l.includes(PREFIX));

test('planted control: an unmarked retired entry and README are caught', () => {
  assert.deepEqual(unmarkedEntries({ plugins: [{ name: 'fabric', description: 'Multi-provider' },
    { name: 'evolve', description: `${PREFIX}. Loop` }, { name: 'cc-academia', description: 'x' }] }), ['fabric']);
  assert.equal(unmarkedReadme('# fabric\n\nMulti-provider\n'), true);
  assert.equal(unmarkedReadme(`# fabric\n\n> **${PREFIX}.**\n`), false);
});

test('every retired marketplace entry says so, and cc-academia is the one live plugin', () => {
  assert.deepEqual(unmarkedEntries(market), []);
  assert.deepEqual(market.plugins.filter((p) => !RETIRED.includes(p.name)).map((p) => p.name), ['cc-academia']);
});

test('every retired plugin README says so in its first lines', () => {
  const present = RETIRED.filter((name) => existsSync(join(root, name)));
  assert.deepEqual(present.filter((name) => unmarkedReadme(readFileSync(readme(name), 'utf8'))), []);
});

test('traceme leaves nothing behind, and cc-latex points to cc-academia', () => {
  assert.equal(existsSync(join(root, 'traceme')), false);
  assert.match(readFileSync(readme('cc-academia'), 'utf8').split('\n').slice(0, 8).join('\n'), /cc-latex.*RETIRED.*cc-academia|cc-latex.*folded into cc-academia/i);
});
