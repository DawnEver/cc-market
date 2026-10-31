// authority.mjs — user authority for opening and closing a task.
//
// Only the USER opens or closes a task. A regex over tool calls can never close every
// path, so the precondition lives where the write happens: openTask/closeTask CONSUME a
// record that only the user's own prompt creates. hooks/task-authority.js
// (UserPromptSubmit) records a prompt that IS `/rem:task open|close <slug> …` — an agent
// cannot submit a user prompt. Records live outside the repo (os.tmpdir(), per project),
// expire after RECORD_TTL_MS, and are consumed on use.

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { findProjectRoot } from '../shared/lib.mjs';
import { withLock } from '../shared/lock.mjs';
import { atomicWriteFile } from '../shared/atomic-write.mjs';

export const RECORD_TTL_MS = 30 * 60 * 1000;
export const AUTHORITY_DIR = join(tmpdir(), 'rem-task-authority');

// The whole prompt must be the command: a prompt that merely mentions it is not one.
const COMMAND_RE = /^\s*\/(?:rem:)?task\s+(open|close)\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/;

export function parseTaskCommand(prompt) {
  const m = String(prompt || '').match(COMMAND_RE);
  return m ? { verb: m[1], slug: m[2] } : null;
}

function recordsFile(start) {
  const key = createHash('sha256').update(resolve(findProjectRoot(start))).digest('hex').slice(0, 16);
  return join(AUTHORITY_DIR, `${key}.json`);
}

function read(file) {
  try { const r = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(r) ? r : []; }
  catch { return []; }
}

// Called by the UserPromptSubmit hook only. Returns the record, or null for any other prompt.
export function recordUserCommand(start, prompt, session = '', now = Date.now()) {
  const cmd = parseTaskCommand(prompt);
  if (!cmd) return null;
  const file = recordsFile(start);
  const record = {
    id: randomBytes(6).toString('hex'), ...cmd, session: String(session),
    promptHash: createHash('sha256').update(String(prompt)).digest('hex').slice(0, 16), at: now, consumed: false,
  };
  withLock(file, () => {
    const live = read(file).filter(r => now - r.at < RECORD_TTL_MS);
    atomicWriteFile(file, JSON.stringify([...live, record]));
  });
  return record;
}

// The precondition of openTask/closeTask: consume the newest live, unconsumed record for
// exactly this verb and slug, and return its id (written into the task). Throws without one.
export function consumeAuthority(start, verb, slug, now = Date.now()) {
  const file = recordsFile(start);
  return withLock(file, () => {
    const records = read(file);
    const hit = records.filter(r => !r.consumed && r.verb === verb && r.slug === slug && now - r.at < RECORD_TTL_MS)
      .sort((a, b) => b.at - a.at)[0];
    if (!hit) throw new Error(`no user authority to ${verb} task ${slug}: only the user does that, by typing /rem:task ${verb} ${slug} …`);
    hit.consumed = true;
    atomicWriteFile(file, JSON.stringify(records));
    return hit.id;
  });
}
