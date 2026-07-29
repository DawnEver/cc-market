#!/usr/bin/env node
/**
 * recall.js — UserPromptSubmit hook: prompt-time relevance recall.
 *
 * Reads the hook payload on stdin (user prompt, cwd, session_id), scores the
 * memory scope's non-dropped entries against the prompt with a pure heuristic
 * (no model call, <200ms), and injects the top 1–3 entries as
 * `additionalContext`. No matches → exit 0 silently.
 *
 * Candidate frontmatter is cached per scope in a per-host tmpdir file, keyed
 * by a stat-only fingerprint of the memory tree (count + total size + max
 * mtime, incl. _meta.json) — any write invalidates it, so it never goes stale.
 *
 * Codex limitation: Codex has no UserPromptSubmit-equivalent hook, so on a
 * Codex host this script exits 0 silently (detected via inject-rules.js's
 * isCodexHost). Auto-recall is Claude Code only.
 *
 * Both hosts: any failure is swallowed (exit 0) — a recall miss must never
 * break the session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadMemoryState } from "./lib.mjs";
import { parseFrontmatter } from "../shared/lib.mjs";
import { isCodexHost } from "./inject-rules.js";

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
 * Collect candidate entries for a scope: every non-dropped, non-task memory
 * file, with its frontmatter fields and volatile meta. Bodies are NOT read
 * here (only for the winners) to stay under the latency budget.
 */
function collectCandidatesUncached(scopeRoot) {
  const state = loadMemoryState(scopeRoot);
  const memDir = path.join(scopeRoot, ".claude", "memory");
  const out = [];
  for (const [relPath, meta] of state) {
    if (meta.dropped) continue;
    if (isSkippable(relPath)) continue;
    const abs = path.join(memDir, relPath);
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(abs, "utf8")) || {};
    } catch { continue; }
    const md = (fm.metadata && typeof fm.metadata === "object") ? fm.metadata : {};
    out.push({
      relPath,
      abs,
      name: String(fm.name || path.basename(relPath, ".md")),
      description: String(fm.description || ""),
      type: md.type || fm.type || "project",
      accessed: meta.accessed || "",
      count: Number.isFinite(meta.count) ? meta.count : 1,
    });
  }
  return out;
}

// ── Candidate cache ──
// Reading every memory file's frontmatter on every prompt is too slow on
// cloud-synced dirs (OneDrive placeholders). Cache candidates in a per-host
// tmpdir file keyed by a stat-only fingerprint of the memory tree (file count
// + max mtime + total size, including _meta.json). Any write from
// remember.js / touch-memory.js / prune changes the fingerprint, so the cache
// can never serve stale entries; stat calls themselves are cheap. The cache
// lives in os.tmpdir() (not the synced tree) so multi-device setups each keep
// their own — and it never shows up in git status.

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

export function collectCandidates(scopeRoot, { useCache = true } = {}) {
  if (!useCache) return collectCandidatesUncached(scopeRoot);
  const fingerprint = scopeFingerprint(scopeRoot);
  const cacheFile = cacheFileFor(scopeRoot);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.candidates)) {
      return cached.candidates;
    }
  } catch { /* no/invalid cache — rebuild */ }
  const candidates = collectCandidatesUncached(scopeRoot);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ fingerprint, candidates }), "utf8");
  } catch { /* cache is best-effort */ }
  return candidates;
}

/**
 * Heuristic score: token matches against name (×2) + description (×1),
 * weighted by type (user/feedback ×2, project/reference ×1), recency
 * (accessed within 30d boosts up to ×1.3), and access count (×1 + min(count,5)/10).
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
  const days = (now - Date.parse(entry.accessed)) / 86400000;
  const recency = Number.isFinite(days) ? 1 + Math.max(0, 30 - days) / 100 : 1;
  const countFactor = 1 + Math.min(entry.count, 5) / 10;
  return matches * typeWeight * recency * countFactor;
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
  for (const e of entries) {
    let text;
    try {
      text = bodyOf(fs.readFileSync(e.abs, "utf8")).trim();
    } catch { continue; }
    if (!text) continue;
    const block = `\n\n--- ${e.name} (${e.relPath.replace(/\\/g, "/")}) ---\n${text}`;
    if (header.length + body.length + block.length > maxBytes) continue; // try a smaller entry
    body += block;
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

function main() {
  // Codex has no UserPromptSubmit hook — exit silently (see header comment).
  if (isCodexHost()) return;
  const payload = readStdinPayload();
  const prompt = payload.prompt || payload.user_prompt || "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  const tokens = tokenize(prompt);
  if (!tokens.length) return;

  const scope = findScopeForCwd(cwd);
  if (!scope) return;

  const winners = selectTop(collectCandidates(scope), tokens, Date.now());
  const context = buildRecallContext(winners);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // Never break the session on a recall failure.
  }
  process.exit(0);
}
