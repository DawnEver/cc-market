// session-record.mjs — recall's device-local record of one session (tmpdir, one JSON file):
// `root` + `binding` (dev-lab's answer, asked once per session) and `seen` (the task line last
// injected). recall.js reads and writes it; session-context.js drops it on SessionStart and
// PostCompact. Dependency-light, so a hook can drop a record without loading recall.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFile } from '../shared/atomic-write.mjs';

export function sessionFile(session) {
  const key = crypto.createHash('sha1').update(String(session)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'rem-recall-sessions', `${key}.json`);
}

export function readSession(session) {
  try { return JSON.parse(fs.readFileSync(sessionFile(session), 'utf8')); } catch { return {}; }
}

export function writeSession(session, record) {
  try {
    fs.mkdirSync(path.dirname(sessionFile(session)), { recursive: true });
    atomicWriteFile(sessionFile(session), JSON.stringify(record));
  } catch { /* best-effort: a miss costs one more read */ }
}

// Emptied, not removed: rem calls no file-removing API outside its one named remover.
export function forgetSession(session) {
  if (fs.existsSync(sessionFile(session))) writeSession(session, {});
}
