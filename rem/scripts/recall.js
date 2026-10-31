#!/usr/bin/env node
/**
 * recall.js — UserPromptSubmit hook: prompt-time relevance recall.
 *
 * Reads the hook payload on stdin (user prompt, cwd, session_id) and injects, as
 * `additionalContext`, a SCOPED view:
 *   - the bound task (tasks.mjs resolveTask: worktree/branch name) — goal, open
 *     items and the latest journal lines, on every turn;
 *   - the top 1–3 visible memory entries and bound docs scoring against the prompt
 *     (pure heuristic, no model call), drawn from the scope of cwd plus the scopes
 *     of the bound task's `scope:` paths, and the bound docs of those paths;
 *   - never an entry tagged with ANOTHER task (`task: <slug>`), unless the prompt
 *     names that task — other tasks come in only on explicit query.
 * Nothing to say → exit 0 silently.
 *
 * Candidate frontmatter is cached per scope in a per-host tmpdir file, keyed
 * by a stat-only fingerprint of the memory tree (count + total size + max
 * mtime) — any write invalidates it, so it never goes stale.
 *
 * Read-only toward the repo: recall never writes the memory tree or any state
 * file (its cache and telemetry live in os.tmpdir()).
 *
 * Claude Code and Codex share the UserPromptSubmit additionalContext contract.
 *
 * Both hosts: any failure is swallowed (exit 0) — a recall miss must never
 * break the session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { listEntries, visibleEntries } from "./lib.mjs";
import { readTask, listTasks, resolveTask } from "./tasks.mjs";
import { collectBoundDocs } from "./doc-freshness.js";
import { isMain, findProjectRoot } from "../shared/lib.mjs";
import { atomicWriteFile } from "../shared/atomic-write.mjs";

// Module-eval start: excludes node boot + import load (unmeasurable from
// inside), captures everything else. Used by the telemetry ring.
const T0 = Date.now();

// Body = everything after the closing --- of the frontmatter block.
function bodyOf(content) {
  const m = content && content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? content.slice(m[0].length) : content;
}

const MAX_ENTRIES = 3;
const MAX_BYTES = 4096;
const SCORE_THRESHOLD = 2;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with",
  "this", "that", "these", "those", "from", "have", "has", "had", "was",
  "were", "will", "would", "can", "could", "should", "what", "when", "where",
  "which", "who", "why", "how", "all", "any", "each", "into", "out", "about",
  "there", "here", "then", "than", "too", "very", "just", "also", "some",
  "such", "only", "own", "same", "over", "under", "again", "once", "does",
  "did", "doing", "done", "its", "it's", "our", "ours", "their", "theirs",
  "him", "his", "her", "hers", "them", "they", "she", "him", "use", "using",
  "used", "make", "made", "get", "got", "let", "may", "might", "must",
  "shall", "being", "been", "don't", "doesn't", "isn't", "aren't", "won't",
]);

/** Lowercase, split on non-alphanumeric, drop stopwords and tokens <3 chars. */
// CJK runs (Han, Kana, Hangul) have no spaces to split on — segment them into
// bigrams (single chars kept as-is) so Chinese/Japanese/Korean prompts can
// match CJK memory names/descriptions instead of tokenizing to nothing.
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu;

export function tokenize(text) {
  if (!text) return [];
  const out = new Set();
  const latin = String(text).toLowerCase().replace(CJK_RE, (run) => {
    if (run.length === 1) { out.add(run); return " "; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    return " ";
  });
  for (const tok of latin.split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

/**
 * Walk up from cwd to the nearest directory containing `.claude/memory/`
 * (the memory scope). null when no scope exists anywhere above.
 */
export function findScopeForCwd(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".claude", "memory"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Task/manual bookkeeping files are never recalled. */
export function isSkippable(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  if (norm.startsWith("tasks/")) return true;
  return path.basename(norm).toLowerCase() === "manual.md";
}

/**
 * Candidate entries for a scope: every visible memory entry with its
 * frontmatter fields. Bodies are NOT read here (only for the winners).
 */
function collectCandidatesUncached(scopeRoot) {
  const memDir = path.join(scopeRoot, ".claude", "memory");
  return visibleEntries(listEntries(scopeRoot))
    .filter((e) => !isSkippable(e.path))
    .map((e) => ({
      relPath: e.path,
      abs: path.join(memDir, e.path),
      name: e.name,
      description: e.description,
      type: e.type || "project",
      task: e.task,
      date: e.date,
      corrections: e.correctedBy.map((p) => ({ relPath: p, abs: path.join(memDir, p) })),
    }));
}

// ── Bound docs ──
// A bound doc (frontmatter `doc_source`) explains how code works NOW. Discovery reads
// every tracked markdown file, so it is cached in tmpdir and refreshed only when git's
// index changes (a doc added, moved or committed).

function gitIndexStamp(root) {
  let gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) gitDir = path.resolve(root, m[1].trim());
    }
    return String(fs.statSync(path.join(gitDir, "index")).mtimeMs);
  } catch { return "0"; }
}

export function collectDocs(root, { now = Date.now(), ttl = FINGERPRINT_TTL_MS } = {}) {
  const key = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16);
  const cacheFile = path.join(os.tmpdir(), `rem-recall-docs-${key}.json`);
  const stamp = gitIndexStamp(root);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached.stamp === stamp && now - cached.ts < ttl * 20) return cached.docs;
  } catch { /* rebuild */ }
  const docs = collectBoundDocs(root).map((d) => {
    let name = path.basename(d.relPath, ".md"), description = "";
    try {
      const text = fs.readFileSync(d.full, "utf8");
      name = text.match(/^name:\s*(.+)$/m)?.[1].trim() || name;
      description = text.match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, "") || "";
    } catch { /* keep defaults */ }
    return { relPath: d.relPath, abs: d.full, name, description, type: "doc", docSource: d.doc_source };
  });
  try { atomicWriteFile(cacheFile, JSON.stringify({ ts: now, stamp, docs })); } catch { /* best-effort */ }
  return docs;
}

// True when a doc's sources and the paths being worked on overlap (either contains the other).
export function docCovers(doc, workPaths) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "");
  return doc.docSource.some((s) => workPaths.some((w) => {
    const a = norm(s), b = norm(w);
    return !a || !b || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  }));
}

// ── The bound task ──

const TASK_TAIL = 8;

export function taskBlock(task) {
  const journal = (() => {
    try { return fs.readFileSync(path.join(task.dir, "JOURNAL.md"), "utf8"); } catch { return ""; }
  })();
  const tail = journal.split(/\r?\n/).filter((l) => l.startsWith("- ")).slice(-TASK_TAIL);
  const lines = [`Bound task: ${task.slug} — ${task.goal} (${task.status})`];
  if (task.scope.length) lines.push(`Scope: ${task.scope.join(", ")}`);
  if (task.openItems.length) lines.push(`Open items: ${task.openItems.map((i) => `O${i.n} open: ${i.text}`).join("; ")}`);
  if (tail.length) lines.push("Latest journal (.claude/tasks/" + task.slug + "/JOURNAL.md):", ...tail);
  return lines.join("\n");
}

// Tasks the prompt names explicitly (whole slug, hyphen-aware).
export function queriedTasks(prompt, slugs) {
  const text = String(prompt).toLowerCase();
  return new Set(slugs.filter((s) => new RegExp(`(^|[^a-z0-9-])${s}($|[^a-z0-9-])`).test(text)));
}

// ── Candidate cache ──
// Reading every memory file's frontmatter on every prompt is too slow on
// cloud-synced dirs (OneDrive placeholders). Cache candidates in a per-host
// tmpdir file keyed by a stat-only fingerprint of the memory tree (file count
// + max mtime + total size).
//
// The whole tree is re-statted at most once per FINGERPRINT_TTL_MS (30s):
// within the window the cache is served without touching the memory tree at
// all, so the per-prompt cost is a single statSync on the cache file. Any
// write from remember.js / merge-memory.js / crystallize.js changes the fingerprint and
// is picked up on the next expiry (staleness bounded by the TTL — acceptable
// for best-effort recall). The cache lives in os.tmpdir() (not the synced
// tree) so multi-device setups each keep their own — and it never shows up in
// git status.

export const FINGERPRINT_TTL_MS = 30_000;

export function scopeFingerprint(scopeRoot) {
  const memDir = path.join(scopeRoot, ".claude", "memory");
  let count = 0, maxMtime = 0, totalSize = 0;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.statSync(full);
        count++;
        totalSize += st.size;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch { /* vanished mid-walk */ }
    }
  })(memDir);
  return `${count}:${totalSize}:${maxMtime}`;
}

function cacheFileFor(scopeRoot) {
  const key = crypto.createHash("sha1").update(path.resolve(scopeRoot)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `rem-recall-${key}.json`);
}

export function collectCandidates(scopeRoot, { useCache = true, info, now = Date.now(), ttl = FINGERPRINT_TTL_MS } = {}) {
  if (!useCache) return collectCandidatesUncached(scopeRoot);
  const cacheFile = cacheFileFor(scopeRoot);
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch { /* no/invalid cache — rebuild */ }

  // Fast path: cache fresh within TTL → serve without touching the memory tree.
  if (cached && Array.isArray(cached.candidates) && Number.isFinite(cached.ts) && now - cached.ts < ttl) {
    if (info) { info.cacheHit = true; info.fast = true; }
    return cached.candidates;
  }

  // TTL expired → re-stat the tree and compare fingerprints.
  const fingerprint = scopeFingerprint(scopeRoot);
  if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.candidates)) {
    // Tree unchanged → reuse candidates, only refresh the TTL stamp.
    cached.ts = now;
    try { atomicWriteFile(cacheFile, JSON.stringify(cached)); } catch { /* best-effort */ }
    if (info) { info.cacheHit = true; info.fast = false; }
    return cached.candidates;
  }

  // Tree changed → rebuild candidates.
  if (info) { info.cacheHit = false; info.fast = false; }
  const candidates = collectCandidatesUncached(scopeRoot);
  try {
    atomicWriteFile(cacheFile, JSON.stringify({ ts: now, fingerprint, candidates }));
  } catch { /* cache is best-effort */ }
  return candidates;
}

// ── Telemetry ──
// Per-scope ring (last 20 runs) in a device-local tmpdir file, next to the
// candidate cache. Exists to answer "why did the hook time out?" with data.
// A run writes a pending row BEFORE the potentially slow work and finalizes
// it after: a row stuck at done:false means the process was killed mid-run
// (e.g. by the hook timeout) — exactly the events this exists to capture.
// Read with `recall.js --telemetry`.

const TELEMETRY_RING = 20;

function telemetryFileFor(scopeRoot) {
  const key = crypto.createHash("sha1").update(path.resolve(scopeRoot)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `rem-recall-telemetry-${key}.json`);
}

function readRing(file) {
  try {
    const ring = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(ring) ? ring : [];
  } catch { return []; }
}

export function appendTelemetry(scopeRoot, record) {
  try {
    const file = telemetryFileFor(scopeRoot);
    const ring = readRing(file);
    ring.push(record);
    atomicWriteFile(file, JSON.stringify(ring.slice(-TELEMETRY_RING)));
  } catch { /* telemetry is best-effort */ }
}

/** Replace the newest pending (done:false) row with the completed record. */
export function finalizeTelemetry(scopeRoot, record) {
  try {
    const file = telemetryFileFor(scopeRoot);
    const ring = readRing(file);
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i] && ring[i].done === false) { ring[i] = record; break; }
    }
    atomicWriteFile(file, JSON.stringify(ring.slice(-TELEMETRY_RING)));
  } catch { /* telemetry is best-effort */ }
}

function printTelemetry() {
  // Scan tmpdir for all scope rings (telemetry files are per-scope, keyed by
  // an opaque hash — enumerate rather than guess the current scope).
  let files = [];
  try {
    files = fs.readdirSync(os.tmpdir())
      .filter((f) => f.startsWith("rem-recall-telemetry-") && f.endsWith(".json"));
  } catch { /* none */ }
  const rows = [];
  for (const f of files) {
    try {
      for (const r of JSON.parse(fs.readFileSync(path.join(os.tmpdir(), f), "utf8"))) {
        rows.push(r);
      }
    } catch { /* skip corrupt ring */ }
  }
  rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  if (!rows.length) { console.log("no telemetry recorded yet"); return; }
  for (const r of rows) {
    if (r.done === false) {
      console.log(`${r.t}  KILLED mid-run (hook timeout or crash)`);
    } else {
      console.log(`${r.t}  ${String(r.ms).padStart(5)}ms  cache=${r.cache ? "hit " : "MISS"}  fast=${r.fast ? "yes" : " no"}  cands=${r.cands}  injected=${r.injected}`);
    }
  }
  const times = rows.filter((r) => r.done !== false).map((r) => r.ms).sort((a, b) => a - b);
  const killed = rows.length - times.length;
  if (times.length) {
    const max = times[times.length - 1];
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    console.log(`\n${times.length} completed — max ${max}ms, p95 ${p95}ms; ${killed} killed mid-run`);
  } else {
    console.log(`\n0 completed, ${killed} killed mid-run`);
  }
}

/**
 * Heuristic score: token matches against name (×2) + description (×1),
 * weighted by type (user/feedback ×2, project/reference ×1) and recency
 * (an entry dated within 30d boosts up to ×1.3). The date is the entry's path.
 * An entry of the bound task carries `boost` (×2).
 */
export function scoreEntry(entry, tokens, now = Date.now()) {
  if (!tokens.length) return 0;
  const name = entry.name.toLowerCase();
  const desc = entry.description.toLowerCase();
  let matches = 0;
  for (const tok of tokens) {
    if (name.includes(tok)) matches += 2;
    else if (desc.includes(tok)) matches += 1;
  }
  if (!matches) return 0;

  const typeWeight = entry.type === "user" || entry.type === "feedback" ? 2 : 1;
  const days = (now - Date.parse(entry.date)) / 86400000;
  const recency = Number.isFinite(days) ? 1 + Math.max(0, 30 - days) / 100 : 1;
  return matches * typeWeight * recency * (entry.boost || 1);
}

/** Rank candidates, return the top 1–3 above threshold (best first). */
export function selectTop(candidates, tokens, now) {
  return candidates
    .map((e) => ({ entry: e, score: scoreEntry(e, tokens, now) }))
    .filter((s) => s.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ENTRIES)
    .map((s) => s.entry);
}

/**
 * Build the additionalContext block: header + winner bodies, capped at
 * maxBytes total. null when there is nothing worth injecting.
 */
export function buildRecallContext(entries, maxBytes = MAX_BYTES) {
  if (!entries.length) return null;
  const header = "Relevant memories (auto-recalled):";
  let body = "";
  const shown = new Set();
  const read = (abs) => { try { return bodyOf(fs.readFileSync(abs, "utf8")).trim(); } catch { return ""; } };
  for (const e of entries) {
    if (shown.has(e.relPath)) continue;
    const text = read(e.abs);
    if (!text) continue;
    // A corrected entry travels with its corrections: the old text alone would mislead.
    const fixes = (e.corrections || []).filter((c) => !shown.has(c.relPath));
    const note = fixes.length ? ` [corrected by ${fixes.map((c) => c.relPath).join(", ")}]` : "";
    const kind = e.type === "doc" ? "doc: " : "";
    let block = `\n\n--- ${kind}${e.name} (${e.relPath.replace(/\\/g, "/")})${note} ---\n${text}`;
    for (const c of fixes) {
      const fix = read(c.abs);
      if (fix) block += `\n\n--- correction (${c.relPath}) ---\n${fix}`;
    }
    if (header.length + body.length + block.length > maxBytes) continue; // try a smaller entry
    body += block;
    shown.add(e.relPath);
    for (const c of fixes) shown.add(c.relPath);
  }
  if (!body) return null;
  return header + body;
}

function readStdinPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The scoped context for one prompt in `cwd`, or null. Read-only toward the repo.
 */
export function scopedContext(prompt, cwd, now = Date.now()) {
  const root = findProjectRoot(cwd);
  const tasks = listTasks(root);
  const bound = resolveTask(root, {});
  const task = bound ? readTask(root, bound) : null;
  const queried = queriedTasks(prompt, tasks.map((t) => t.slug));
  const parts = [];
  if (task) parts.push(taskBlock(task));

  const tokens = tokenize(prompt);
  const home = findScopeForCwd(cwd);
  if (tokens.length && home) {
    // Paths being worked on: the bound task's scope, else the cwd's scope directory.
    const workPaths = task?.scope.length ? task.scope : [path.relative(root, home).replace(/\\/g, "/")];
    const scopes = new Set([home]);
    for (const p of task?.scope || []) {
      const s = findScopeForCwd(path.join(root, p));
      if (s) scopes.add(s);
    }
    const info = {};
    appendTelemetry(home, { t: new Date().toISOString(), done: false });
    const entries = [...scopes].flatMap((s) => collectCandidates(s, { info }))
      .filter((e) => !e.task || e.task === bound || queried.has(e.task))
      .map((e) => (e.task && e.task === bound ? { ...e, boost: 2 } : e));
    const docs = collectDocs(root).filter((d) => docCovers(d, workPaths));
    const candidates = [...entries, ...docs.map((d) => ({ ...d, date: "" }))];
    const recalled = buildRecallContext(selectTop(candidates, tokens, now));
    finalizeTelemetry(home, {
      t: new Date().toISOString(),
      done: true,
      ms: Date.now() - T0,
      cache: info.cacheHit !== false,
      fast: info.fast === true,
      cands: candidates.length,
      injected: Boolean(recalled),
    });
    if (recalled) parts.push(recalled);
  }
  return parts.length ? parts.join("\n\n") : null;
}

function main() {
  if (process.argv.includes("--telemetry")) { printTelemetry(); return; }
  const payload = readStdinPayload();
  const prompt = payload.prompt || payload.user_prompt || "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  const context = scopedContext(prompt, cwd);
  if (!context) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    }),
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch {
    // Never break the session on a recall failure.
  }
  process.exit(0);
}
