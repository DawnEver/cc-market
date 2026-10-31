// authority.mjs — user authority for opening and closing a task.
//
// What this does, honestly: opening/closing a task is REFUSED BY DEFAULT (no matching
// authority record → openTask/closeTask throw; hooks/task-guard.js refuses the visible
// attempts) and DETECTABLE WHEN BYPASSED (scope-validate checks each task's authority id
// against this history; git history shows who wrote TASK.md). It cannot PREVENT a
// determined agent: the hook and the agent's shell run as the same OS user, so the agent
// can write this store too. Prevention would need a privilege boundary.
//
// hooks/task-authority.js (UserPromptSubmit) appends a `granted` event when the user's
// prompt IS `/rem:task open|close <slug> …`. openTask/closeTask append `consumed` for the
// newest live grant of that verb and slug. The history is append-only (events are never
// removed); a grant is live for RECORD_TTL_MS. Store: ~/.claude/rem/authority/<project>.jsonl,
// directory mode 0o700 and owned by the current user on POSIX — never a shared temp dir.

import { readFileSync, appendFileSync, mkdirSync, statSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { findProjectRoot } from '../shared/lib.mjs';
import { withLock } from '../shared/lock.mjs';

export const RECORD_TTL_MS = 30 * 60 * 1000;

// The whole prompt must be the command: a prompt that merely mentions it is not one.
const COMMAND_RE = /^\s*\/(?:rem:)?task\s+(open|close)\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/;

export function parseTaskCommand(prompt) {
  const m = String(prompt || '').match(COMMAND_RE);
  return m ? { verb: m[1], slug: m[2] } : null;
}

// Resolved per call (homedir() reads HOME/USERPROFILE), created owner-only.
export function authorityDir() {
  const dir = join(homedir(), '.claude', 'rem', 'authority');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const st = statSync(dir);
    if (st.uid !== process.getuid()) throw new Error(`${dir} is not owned by the current user`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

function historyFile(start) {
  const key = createHash('sha256').update(resolve(findProjectRoot(start))).digest('hex').slice(0, 16);
  return join(authorityDir(), `${key}.jsonl`);
}

export function readHistory(start) {
  let text = '';
  try { text = readFileSync(historyFile(start), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const append = (file, event) => appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });

// Called by the UserPromptSubmit hook only. Returns the grant, or null for any other prompt.
export function recordUserCommand(start, prompt, session = '', now = Date.now()) {
  const cmd = parseTaskCommand(prompt);
  if (!cmd) return null;
  const file = historyFile(start);
  const grant = {
    event: 'granted', id: randomBytes(6).toString('hex'), ...cmd, session: String(session),
    promptHash: createHash('sha256').update(String(prompt)).digest('hex').slice(0, 16), at: now,
  };
  withLock(file, () => append(file, grant));
  return grant;
}

// The precondition of openTask/closeTask: consume the newest live, unconsumed grant for
// exactly this verb and slug, and return its id (written into the task). Throws without one.
export function consumeAuthority(start, verb, slug, now = Date.now()) {
  const file = historyFile(start);
  return withLock(file, () => {
    const events = readHistory(start);
    const spent = new Set(events.filter(e => e.event === 'consumed').map(e => e.id));
    const hit = events.filter(e => e.event === 'granted' && !spent.has(e.id) && e.verb === verb && e.slug === slug && now - e.at < RECORD_TTL_MS)
      .sort((a, b) => b.at - a.at)[0];
    if (!hit) throw new Error(`no user authority to ${verb} task ${slug}: the user types /rem:task ${verb} ${slug} …`);
    append(file, { event: 'consumed', id: hit.id, verb, slug, at: now });
    return hit.id;
  });
}

// Detection: why a task's authority id does not hold up, or null when it does.
export function authorityProblem(start, slug, id) {
  const events = readHistory(start).filter(e => e.id === id);
  if (!events.some(e => e.event === 'granted')) return `authority ${id} is not in the authority history`;
  if (!events.some(e => e.event === 'consumed' && e.verb === 'open' && e.slug === slug)) return `authority ${id} was not consumed by opening ${slug}`;
  return null;
}

// Probe mode (REM_AUTHORITY_PROBE=1): record the raw prompt the hook received, so the one
// live check of the prompt shape is cheap. See skills/rem/reference/tasks.md.
export function probe(prompt, now = Date.now()) {
  append(join(authorityDir(), 'probe.jsonl'), { time: new Date(now).toISOString(), prompt: String(prompt) });
}
