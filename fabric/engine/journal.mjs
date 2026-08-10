// engine/journal.mjs — append-only session journal (G4). The in-process registry forgets
// everything on restart; this jsonl trail is the FACT record that lets the layer above
// reconcile afterwards — kill-or-adopt is ITS decision, fabric only reports.
//
// Events: { ts, event: 'spawn'|'close'|'close_failed'|'loss', id, pid?, nativeId?, provider?, node?, ... }
// Location: FABRIC_JOURNAL_DIR (tests) or ~/.fabric.
//
// ONE FILE PER WRITER (sharp-review SR-028/SR-044). Every fabric process — each MCP
// server, serve.mjs, every console — used to append to one journal.jsonl with no lock;
// appendFileSync gives no line-integrity guarantee across processes on Windows, and a
// torn line is precisely the spawn record reconcile needs to find an orphan. Each
// process now owns `journal-<pid>.jsonl` and is its only writer, so appendFileSync is
// again atomic-enough and crash-safe. The read side merges every `journal*.jsonl`
// (including the legacy single file) and sorts by ts.
//
// THE SIZE BOUND (SR-006). A process's own file is bounded by its lifetime. The fleet's
// history is bounded by compactJournal(): it folds every OTHER file into one
// `journal-compact.jsonl`, dropping spawns that already have a matching close/loss —
// a settled session is a fact nobody needs to replay. What remains is O(open sessions),
// so reconcile() can stay a full merged read.
//
// FAILURES ARE LOUD, NOT SWALLOWED (SR-007/SR-021). A failed append warns once per
// process on stderr and increments journalWriteFailures(); unparseable lines are counted
// and surfaced as `corruptLines` so a caller can say "this list may be incomplete".
// Writes still never throw at the caller — a journal failure must not take a live
// session down with it.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const LIVE_FILE = `journal-${process.pid}.jsonl`;
const COMPACT_FILE = "journal-compact.jsonl";
const isJournalFile = (name) => /^journal.*\.jsonl$/.test(name);

let writeFailures = 0;
let warnedOnce = false;
const ensuredDirs = new Set(); // mkdir once per directory, not once per event (SR-035)

export function journalDir() {
  return process.env.FABRIC_JOURNAL_DIR || join(homedir(), ".fabric");
}

/** This process's own journal file — the only file this process ever writes. */
export function journalPath() {
  return join(journalDir(), LIVE_FILE);
}

/** How many appends have failed in this process. A non-zero count means the fact record has holes. */
export function journalWriteFailures() {
  return writeFailures;
}

// Auto-bounding (2026-08-10): the live file rotates once it passes MAX_LIVE_FILE_BYTES
// (rename, start fresh) so a long-lived process cannot grow one file forever. The
// rotated chunk waits for the next serve/console start to be folded by compactJournal()
// (folding must not race a live writer, so it only happens at boot). History therefore
// stays bounded: hot file ≤ ~1 MiB, everything else folded at restart to O(open sessions).
const MAX_LIVE_FILE_BYTES = Number(process.env.FABRIC_JOURNAL_MAX_BYTES) || 1024 * 1024;
let rotSeq = 0;

function rotateIfOversized() {
  const dir = journalDir();
  const p = join(dir, LIVE_FILE);
  try {
    if (statSync(p).size < MAX_LIVE_FILE_BYTES) return;
    // Own-pid rename is atomic and safe: only this process ever writes this file.
    renameSync(p, join(dir, `journal-${process.pid}-rot-${++rotSeq}.jsonl`));
  } catch { /* best-effort: an unreadable/absent file is not worth failing an append over */ }
}

export function recordEvent(ev) {
  try {
    const dir = journalDir();
    if (!ensuredDirs.has(dir)) { mkdirSync(dir, { recursive: true }); ensuredDirs.add(dir); }
    appendFileSync(join(dir, LIVE_FILE), `${JSON.stringify({ ts: Date.now(), ...ev })}\n`);
    rotateIfOversized();
  } catch (e) {
    writeFailures++;
    if (!warnedOnce) {
      warnedOnce = true; // warn, do not spam: one line per process is enough to be noticed
      try { process.stderr.write(`fabric journal: writes failing: ${e?.code || e?.message || e}\n`); } catch { /* stderr gone */ }
    }
  }
}

function journalFiles(dir) {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).filter(isJournalFile).sort(); } catch { return []; }
}

/**
 * Every event from every journal file in the directory, sorted by ts.
 * @param {{withStats?: boolean}} [opts]
 * @returns {object[] | {events: object[], corruptLines: number}}
 *   Default shape stays a plain array — `withStats` opts into the unparseable-line count.
 */
export function readJournal({ withStats = false } = {}) {
  const dir = journalDir();
  const events = [];
  let corruptLines = 0;
  for (const name of journalFiles(dir)) {
    let raw;
    try { raw = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { corruptLines++; }
    }
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)); // Array.sort is stable: same-ts keeps file order
  return withStats ? { events, corruptLines } : events;
}

/**
 * Sessions with a spawn but no close/loss — the restart orphan candidates. `pidAlive`
 * is checked per orphan (signal 0); a dead pid means "reap the record", a live one
 * means "a child may still be running — kill or adopt".
 *
 * The returned array carries a non-enumerable `corruptLines`: unreadable journal lines
 * mean this list may be INCOMPLETE, and a caller that reports orphans should say so.
 */
export function reconcile({ _pidAlive = pidAlive } = {}) {
  const { events, corruptLines } = readJournal({ withStats: true });
  const open = new Map();
  for (const ev of events) {
    if (ev.event === "spawn") open.set(ev.id, ev);
    else if (ev.event === "close" || ev.event === "loss") open.delete(ev.id);
    // close_failed deliberately does NOT settle: a close that threw may have left the
    // child running (SR-016), so the record stays an orphan candidate.
  }
  // A remote session's pid lives in the PEER's process table — checking it locally is
  // meaningless, and PID reuse would make pidAlive:true an invitation to kill an
  // unrelated local process (sharp-review SR-003). Remote liveness is reported UNKNOWN.
  const out = [...open.values()].map((ev) => ({
    ...ev,
    pidAlive: ev.node != null ? null : (ev.pid ? _pidAlive(ev.pid) : false),
  }));
  Object.defineProperty(out, "corruptLines", { value: corruptLines, enumerable: false });
  return out;
}

/**
 * Bound the history: fold every journal file EXCEPT this process's live one into a single
 * `journal-compact.jsonl`, keeping only events for sessions that are still open (plus any
 * event with no id), then delete the folded inputs. The live file is left untouched
 * because it has a writer — this process — and merging it would duplicate its events.
 *
 * @returns {{files: number, kept: number, dropped: number}}
 */
export function compactJournal() {
  const dir = journalDir();
  const inputs = journalFiles(dir).filter((n) => n !== LIVE_FILE);
  if (!inputs.length) return { files: 0, kept: 0, dropped: 0 };

  const events = [];
  for (const name of inputs) {
    let raw;
    try { raw = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* a torn line carries no fact to keep */ }
    }
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const settled = new Set();
  for (const ev of events) if (ev.event === "close" || ev.event === "loss") settled.add(ev.id);
  const kept = events.filter((ev) => ev.id == null || !settled.has(ev.id));

  try {
    if (!ensuredDirs.has(dir)) { mkdirSync(dir, { recursive: true }); ensuredDirs.add(dir); }
    writeFileSync(join(dir, COMPACT_FILE), kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  } catch (e) {
    writeFailures++;
    return { files: inputs.length, kept: 0, dropped: 0, error: String(e?.code || e?.message || e) };
  }
  for (const name of inputs) {
    if (name === COMPACT_FILE) continue; // just rewritten
    try { rmSync(join(dir, name)); } catch { /* another process may hold it; next compaction retries */ }
  }
  return { files: inputs.length, kept: kept.length, dropped: events.length - kept.length };
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
