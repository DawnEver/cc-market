// spawn.test.mjs — shared/spawn.mjs enforces windowsHide on child_process wrappers
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withHide, execFileSync, spawnSync } from '../spawn.mjs';

describe('withHide', () => {
  it('sets windowsHide on empty options', () => {
    assert.deepEqual(withHide(), { windowsHide: true });
  });

  it('preserves caller options', () => {
    const opts = withHide({ encoding: 'utf8', cwd: '/x' });
    assert.equal(opts.encoding, 'utf8');
    assert.equal(opts.cwd, '/x');
    assert.equal(opts.windowsHide, true);
  });

  it('cannot be overridden to false', () => {
    assert.equal(withHide({ windowsHide: false }).windowsHide, true);
  });
});

describe('wrappers', () => {
  it('execFileSync runs a command and returns output', () => {
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    assert.equal(out, 'ok');
  });

  it('spawnSync runs a command', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(r.status, 0);
  });
});
