/**
 * Tests for rem/scripts/prune-memory.js — time-based retention + promote-first.
 *   - Eviction is time-based ONLY (>90d stale short-term); there is NO count
 *     capacity cap, so an active working set is never treadmill-dropped.
 *   - Promote-first: a short-term entry at count>=3 is upgraded to long before
 *     stale eviction, protecting it from the 90-day window.
 *   - `metadata.type: feedback` stays exempt from the 90-day stale eviction.
 * Run: node --test cc-market/rem/tests/prune-memory.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PRUNE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "prune-memory.js"
);

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prune-memory-"));
  fs.mkdirSync(path.join(tmp, ".git")); // anchor findProjectRoot
  fs.mkdirSync(path.join(tmp, ".claude", "memory"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...args) {
  return execFileSync(process.execPath, [PRUNE, ...args], {
    cwd: tmp,
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    encoding: "utf8",
  });
}

// Write a memory file + its _meta.json record. `accessed`/`count`/`type` configurable.
function addEntry(date, slug, { accessed, count = 1, type = "project", tier = "short" } = {}) {
  const [y, m, d] = date.split("-");
  const dir = path.join(tmp, ".claude", "memory", y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: test entry\nmetadata:\n  type: ${type}\n---\n\nbody\n`
  );
  const metaFile = path.join(dir, "_meta.json");
  const meta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8"))
    : {};
  meta[`${slug}.md`] = { accessed: accessed || date, count, tier };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

function metaOf(date, slug) {
  const [y, m, d] = date.split("-");
  const metaFile = path.join(tmp, ".claude", "memory", y, m, d, "_meta.json");
  return JSON.parse(fs.readFileSync(metaFile, "utf8"))[`${slug}.md`];
}

// A date comfortably older than the 90-day stale window.
const OLD = "2025-01-01";
const RECENT = "2026-07-20";

describe("prune-memory type-aware retention", () => {
  test("stale non-feedback entry is evicted with --evict-stale", () => {
    addEntry(OLD, "old-project", { accessed: OLD });
    const out = run("--evict-stale");
    assert.match(out, /1 stale short-term entries/);
    assert.equal(metaOf(OLD, "old-project").dropped, "stale-90d");
  });

  test("stale feedback entry is exempt from 90d eviction", () => {
    addEntry(OLD, "old-feedback", { accessed: OLD, type: "feedback" });
    const out = run("--evict-stale");
    assert.match(out, /1 stale feedback entries exempt/);
    assert.equal(metaOf(OLD, "old-feedback").dropped, undefined);
  });

  test("feedback exemption does not shield other stale entries in the same run", () => {
    addEntry(OLD, "old-feedback", { accessed: OLD, type: "feedback" });
    addEntry(OLD, "old-project", { accessed: OLD });
    const out = run("--evict-stale");
    assert.match(out, /1 stale short-term entries/);
    assert.match(out, /1 stale feedback entries exempt/);
    assert.equal(metaOf(OLD, "old-feedback").dropped, undefined);
    assert.equal(metaOf(OLD, "old-project").dropped, "stale-90d");
  });

  test("no capacity cap: >20 recent shorts are all retained under --evict-stale", () => {
    // 21 recent short-term entries, none stale — the old >20 capacity treadmill
    // would have dropped the oldest; time-based eviction retains every one.
    for (let i = 0; i < 21; i++) {
      addEntry(RECENT, `recent-${String(i).padStart(2, "0")}`, { accessed: RECENT });
    }
    const out = run("--evict-stale");
    assert.match(out, /21 total \(0 long, 21 short\), 0 stale/);
    assert.equal(metaOf(RECENT, "recent-00").dropped, undefined);
    assert.equal(metaOf(RECENT, "recent-20").dropped, undefined);
  });

  test("promote-first: a count>=3 short is promoted to long, not stale-evicted", () => {
    // Stale (OLD) but re-accessed on >=3 days → promoted to long before eviction,
    // so it survives the 90-day window instead of being dropped.
    addEntry(OLD, "worn-project", { accessed: OLD, count: 3 });
    const out = run("--evict-stale");
    assert.match(out, /promoting to long/);
    assert.equal(metaOf(OLD, "worn-project").dropped, undefined);
    assert.equal(metaOf(OLD, "worn-project").tier, "long");
  });

  test("a count<3 stale short is still stale-90d evicted", () => {
    addEntry(OLD, "cold-project", { accessed: OLD, count: 1 });
    const out = run("--evict-stale");
    assert.match(out, /1 stale short-term entries/);
    assert.equal(metaOf(OLD, "cold-project").dropped, "stale-90d");
  });

  test("--dry-run drops nothing", () => {
    addEntry(OLD, "old-project", { accessed: OLD });
    run("--evict-stale", "--dry-run");
    assert.equal(metaOf(OLD, "old-project").dropped, undefined);
  });
});
