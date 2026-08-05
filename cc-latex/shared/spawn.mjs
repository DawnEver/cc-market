// shared/spawn.mjs — child_process wrappers that enforce `windowsHide: true`
// Invariant (cc-market/.claude/rules/invariants.md): every console-app child launched
// from a hook, MCP server, or background script must set windowsHide, or Windows
// flashes a terminal window. Import these instead of child_process so the invariant
// is code, not convention.

import {
  spawn as _spawn,
  spawnSync as _spawnSync,
  execFileSync as _execFileSync,
  execSync as _execSync,
} from 'child_process';

// windowsHide is forced last so a caller can't accidentally drop it.
export function withHide(opts = {}) { return { ...opts, windowsHide: true }; }

export function spawn(cmd, args, opts) { return _spawn(cmd, args, withHide(opts)); }
export function spawnSync(cmd, args, opts) { return _spawnSync(cmd, args, withHide(opts)); }
export function execFileSync(cmd, args, opts) { return _execFileSync(cmd, args, withHide(opts)); }
export function execSync(cmd, opts) { return _execSync(cmd, withHide(opts)); }
