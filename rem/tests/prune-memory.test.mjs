/**
 * Tests for rem/scripts/prune-memory.js — type-aware retention.
 * Entries with frontmatter `metadata.type: feedback` are exempt from the
 * 90-day stale eviction but still count toward the 20-entry capacity cap.
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

// Write a memory file + its _meta.json record. `accessed`/`type` configurable.
function addEntry(date, slug, { accessed, type = "project", tier = "short" } = {}) {
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
  meta[`${slug}.md`] = { accessed: accessed || date, count: 1, tier };
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

  test("feedback entries still count toward and are dropped by the capacity cap", () => {
    // 21 short-term entries, feedback oldest → over the 20 cap, feedback dropped first
    addEntry(OLD, "oldest-feedback", { accessed: OLD, type: "feedback" });
    for (let i = 0; i < 20; i++) {
      addEntry(RECENT, `recent-${String(i).padStart(2, "0")}`, { accessed: RECENT });
    }
    const out = run("--evict-stale");
    assert.match(out, /21 short-term entries, dropping 1 oldest/);
    assert.equal(metaOf(OLD, "oldest-feedback").dropped, "over-capacity");
  });

  test("--dry-run drops nothing", () => {
    addEntry(OLD, "old-project", { accessed: OLD });
    run("--evict-stale", "--dry-run");
    assert.equal(metaOf(OLD, "old-project").dropped, undefined);
  });
});
