// feed-events: `task status` shows the forge events dev-lab's forgefeed kept for the task, read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { keptEvents, keptEventsText, FEED_DIR } from '../scripts/feed-events.mjs';

function homeWith(slug, text) {
  const home = mkdtempSync(join(tmpdir(), 'rem-feed-'));
  if (text !== null) {
    mkdirSync(join(home, FEED_DIR, 'tasks'), { recursive: true });
    writeFileSync(join(home, FEED_DIR, 'tasks', `${slug}.jsonl`), text);
  }
  return home;
}

test('kept events are listed, and reading them consumes nothing', () => {
  const body = '{"line": "gitea/o/r#12 labelled task:t"}\n{"line": "gitea/o/r#13 commented"}\n';
  const home = homeWith('t', body);
  const env = { LAB_COMMONS_HOME: home };
  assert.deepEqual(keptEvents('t', env), { lines: ['gitea/o/r#12 labelled task:t', 'gitea/o/r#13 commented'], note: null });
  assert.match(keptEventsText('t', env), /forge events kept for t \(2;/);
  assert.equal(readFileSync(join(home, FEED_DIR, 'tasks', 't.jsonl'), 'utf8'), body);
});

test('PLANTED: another task, no queue and a torn line show nothing extra', () => {
  const home = homeWith('t', '{"line": "kept"}\nnot json\n{"other": 1}\n');
  const env = { LAB_COMMONS_HOME: home };
  assert.deepEqual(keptEvents('t', env).lines, ['kept']);
  assert.equal(keptEventsText('u', env), '');
  assert.equal(keptEventsText('t', { LAB_COMMONS_HOME: homeWith('t', null) }), '');
});

test('no machine home is one line naming the door, never a throw', () => {
  const text = keptEventsText('t', {});
  assert.match(text, /^forge events not read: LAB_COMMONS_HOME is unset/);
  assert.match(text, /dev_lab\.dev\.remhome --install/);
});
