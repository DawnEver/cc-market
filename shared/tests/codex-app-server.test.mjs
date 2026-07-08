// codex-app-server.test.mjs — clientInfo resolution for the shared codex client.
// The client identifies itself to the codex app-server by the nearest enclosing
// plugin's .claude-plugin/plugin.json (walk-up from the entry script), so the same
// shared module reports "takeover" or "fabric" depending on which plugin runs it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveClientInfo } from '../codex/app-server.mjs';

describe('resolveClientInfo', () => {
  it('finds the nearest .claude-plugin/plugin.json walking up', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-ci-'));
    try {
      mkdirSync(join(root, '.claude-plugin'));
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'someplugin', version: '1.2.3' })
      );
      const deep = join(root, 'scripts', 'codex');
      mkdirSync(deep, { recursive: true });
      const info = resolveClientInfo(join(deep, 'entry.mjs'));
      assert.deepEqual(info, { name: 'someplugin', version: '1.2.3' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to cc-market/0.0.0 when no plugin.json is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-ci-none-'));
    try {
      const info = resolveClientInfo(join(root, 'entry.mjs'));
      assert.deepEqual(info, { name: 'cc-market', version: '0.0.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
