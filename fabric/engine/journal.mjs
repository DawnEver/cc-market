// engine/journal.mjs — append-only session journal (G4). The in-process registry forgets
// everything on restart; this jsonl trail is the FACT record that lets the layer above
// reconcile afterwards — kill-or-adopt is ITS decision, fabric only reports.
//
// Events: { ts, event: 'spawn'|'close'|'loss', id, pid?, nativeId?, provider?, node?, ... }
// Location: FABRIC_JOURNAL_DIR (tests) or ~/.fabric. Writes are best-effort — a journal
// failure must never take a live session down with it.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

export function journalPath() {
  const dir = process.env.FABRIC_JOURNAL_DIR || join(homedir(), ".fabric");
  return join(dir, "journal.jsonl");
}

export function recordEvent(ev) {
  try {
    const p = journalPath();
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ ts: Date.now(), ...ev })}\n`);
  } catch { /* best-effort: never fail the caller for the journal */ }
}

export function readJournal() {
  const p = journalPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/**
 * Sessions with a spawn but no close/loss — the restart orphan candidates. `pidAlive`
 * is checked per orphan (signal 0); a dead pid means "reap the record", a live one
 * means "a child may still be running — kill or adopt".
 */
export function reconcile({ _pidAlive = pidAlive } = {}) {
  const open = new Map();
  for (const ev of readJournal()) {
    if (ev.event === "spawn") open.set(ev.id, ev);
    else if (ev.event === "close" || ev.event === "loss") open.delete(ev.id);
  }
  return [...open.values()].map((ev) => ({ ...ev, pidAlive: ev.pid ? _pidAlive(ev.pid) : false }));
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
