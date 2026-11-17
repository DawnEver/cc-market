// hook-timeouts.test.mjs — every hook a plugin ships declares a timeout of at most 5 seconds
// (user ruling D24, 2026-11-17: "every hook < 5 s, strictly"; a 15 s prompt hook outlived a
// 30-second one-time code). The timeout is the BACKSTOP: each hook must finish well under it on
// its own (fast, or asynchronous with its work detached), and Claude Code treats a hook it kills
// at the timeout as a non-blocking error -- the tool call or prompt proceeds.
// A hook with no timeout gets the host default (60 s for a command hook), so a missing one fails too.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MAX_HOOK_TIMEOUT_S = 5;

/** Every hook of a hooks.json object whose timeout is missing or above the ceiling, as readable lines. */
export function timeoutViolations(hooksJson, label = 'hooks.json') {
  const out = [];
  for (const [event, groups] of Object.entries(hooksJson?.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        const t = hook.timeout;
        if (!(typeof t === 'number' && t > 0 && t <= MAX_HOOK_TIMEOUT_S)) {
          out.push(`${label} ${event} ${hook.command || hook.type}: timeout ${t === undefined ? 'missing' : t}`);
        }
      }
    }
  }
  return out;
}

const plugins = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'hooks', 'hooks.json')))
  .map((d) => d.name);

const hook = (timeout) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js', ...(timeout === undefined ? {} : { timeout }) }] }] } });

describe('every shipped hook declares a timeout of at most 5 s', () => {
  it('PLANTED CONTROLS: a 15 s timeout, a missing one and a zero fail; 5 passes', () => {
    assert.equal(timeoutViolations(hook(15)).length, 1);
    assert.equal(timeoutViolations(hook(undefined)).length, 1);
    assert.equal(timeoutViolations(hook(0)).length, 1);
    assert.deepEqual(timeoutViolations(hook(5)), []);
  });

  it('the scan sees every plugin that ships hooks', () => {
    for (const name of ['rem', 'sharp-review', 'cc-academia']) assert.ok(plugins.includes(name), `${name}/hooks/hooks.json not scanned`);
  });

  for (const name of plugins) {
    it(`${name}/hooks/hooks.json`, () => {
      const file = join(ROOT, name, 'hooks', 'hooks.json');
      assert.deepEqual(timeoutViolations(JSON.parse(readFileSync(file, 'utf8')), `${name}/hooks/hooks.json`), []);
    });
  }
});

// The 5 s are for the whole EVENT, every source together (D24, sharpened the same day): a plugin
// pays one node start per event, so two behaviours of one event share one process.
/** Events of a hooks.json object that start more than one process. */
export function eventsWithSeveralProcesses(hooksJson) {
  return Object.entries(hooksJson?.hooks || {})
    .filter(([, groups]) => (groups || []).flatMap((g) => g.hooks || []).length > 1)
    .map(([event]) => event);
}

describe('a plugin starts at most one hook process per event', () => {
  it('PLANTED CONTROL: two hooks on one event fail', () => {
    const two = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } };
    assert.deepEqual(eventsWithSeveralProcesses(two), ['UserPromptSubmit']);
    assert.deepEqual(eventsWithSeveralProcesses(hook(5)), []);
  });

  for (const name of plugins) {
    it(`${name}/hooks/hooks.json`, () => {
      assert.deepEqual(eventsWithSeveralProcesses(JSON.parse(readFileSync(join(ROOT, name, 'hooks', 'hooks.json'), 'utf8'))), []);
    });
  }
});
