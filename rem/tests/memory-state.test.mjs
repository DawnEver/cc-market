/**
 * Tests for rem/lib.mjs — _meta.json memory state functions.
 * Covers loadMemoryState, saveMemoryMeta, getMemoryMeta, bumpAccessed, dropFromIndex.
 *
 * Run: node --test cc-market/rem/tests/memory-state.test.mjs
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  loadMemoryState,
  saveMemoryMeta,
  getMemoryMeta,
  bumpAccessed,
  dropFromIndex,
} from "../lib.mjs";

// ── Test helpers ──────────────────────────────────────────────────────────

const tmpRoots = [];

function tmpScope() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-mem-state-"));
  fs.mkdirSync(path.join(root, ".claude", "memory"), { recursive: true });
  tmpRoots.push(root);
  return root;
}

function writeMd(root, datePath, slug, content = "") {
  const dir = path.join(root, ".claude", "memory", datePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, slug), content, "utf8");
}

function writeMeta(root, datePath, data) {
  const dir = path.join(root, ".claude", "memory", datePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_meta.json"),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

function readMetaFile(root, datePath) {
  const f = path.join(root, ".claude", "memory", datePath, "_meta.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

afterEach(() => {
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpRoots.length = 0;
});

// ── loadMemoryState ────────────────────────────────────────────────────────

describe("loadMemoryState", () => {
  test("merges multiple _meta.json files across dates", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry-a.md");
    writeMeta(root, "2026/06/10", {
      "entry-a.md": { accessed: "2026-06-10", count: 2, tier: "short" },
    });
    writeMd(root, "2026/06/11", "entry-b.md");
    writeMeta(root, "2026/06/11", {
      "entry-b.md": { accessed: "2026-06-11", count: 1, tier: "long" },
    });

    const state = loadMemoryState(root);
    assert.equal(state.size, 2);
    assert.deepEqual(state.get("2026/06/10/entry-a.md"), {
      accessed: "2026-06-10",
      count: 2,
      tier: "short",
    });
    assert.deepEqual(state.get("2026/06/11/entry-b.md"), {
      accessed: "2026-06-11",
      count: 1,
      tier: "long",
    });
  });

  test("backfills .md files missing from _meta.json with path-date defaults", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry-a.md");
    writeMeta(root, "2026/06/10", {
      "entry-a.md": { accessed: "2026-06-10", count: 3, tier: "long" },
    });
    writeMd(root, "2026/06/10", "entry-b.md"); // NOT in _meta.json

    const state = loadMemoryState(root);
    assert.equal(state.size, 2);
    assert.deepEqual(state.get("2026/06/10/entry-b.md"), {
      accessed: "2026-06-10",
      count: 1,
      tier: "short",
    });
  });
});

// ── saveMemoryMeta ────────────────────────────────────────────────────────

describe("saveMemoryMeta", () => {
  test("writes metadata to correct date directory", () => {
    const root = tmpScope();
    saveMemoryMeta(root, "2026/06/15/new-entry.md", {
      tier: "long",
      count: 3,
      accessed: "2026-06-15",
    });

    const meta = readMetaFile(root, "2026/06/15");
    assert.notEqual(meta, null);
    assert.deepEqual(meta["new-entry.md"], {
      tier: "long",
      count: 3,
      accessed: "2026-06-15",
    });
  });

  test("preserves existing entries in the same _meta.json", () => {
    const root = tmpScope();
    writeMeta(root, "2026/06/15", {
      "existing.md": {
        tier: "short",
        count: 1,
        accessed: "2026-06-15",
      },
    });

    saveMemoryMeta(root, "2026/06/15/new-entry.md", {
      tier: "long",
      count: 3,
      accessed: "2026-06-15",
    });

    const meta = readMetaFile(root, "2026/06/15");
    assert.deepEqual(meta["existing.md"], {
      tier: "short",
      count: 1,
      accessed: "2026-06-15",
    });
    assert.deepEqual(meta["new-entry.md"], {
      tier: "long",
      count: 3,
      accessed: "2026-06-15",
    });
  });

  test("does not affect other date directories", () => {
    const root = tmpScope();
    writeMeta(root, "2026/06/10", {
      "existing.md": { accessed: "2026-06-10", count: 1, tier: "short" },
    });

    saveMemoryMeta(root, "2026/06/15/new-entry.md", {
      tier: "long",
      count: 3,
      accessed: "2026-06-15",
    });

    // 2026/06/10 _meta.json must be untouched
    const meta10 = readMetaFile(root, "2026/06/10");
    assert.deepEqual(meta10, {
      "existing.md": { accessed: "2026-06-10", count: 1, tier: "short" },
    });

    // 2026/06/15 _meta.json must exist with the new entry
    const meta15 = readMetaFile(root, "2026/06/15");
    assert.notEqual(meta15, null);
    assert.ok("new-entry.md" in meta15);
  });
});

// ── bumpAccessed ──────────────────────────────────────────────────────────

describe("bumpAccessed", () => {
  test("increments count when date advances", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "test.md");
    writeMeta(root, "2026/06/10", {
      "test.md": { accessed: "2026-06-10", count: 2, tier: "short" },
    });

    bumpAccessed(root, "2026/06/10/test.md", "2026-06-11");

    const state = loadMemoryState(root);
    const meta = state.get("2026/06/10/test.md");
    assert.equal(meta.accessed, "2026-06-11");
    assert.equal(meta.count, 3);
    assert.equal(meta.tier, "short"); // other fields preserved
  });

  test("keeps same count when date is unchanged", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "test.md");
    writeMeta(root, "2026/06/10", {
      "test.md": { accessed: "2026-06-10", count: 2, tier: "short" },
    });

    bumpAccessed(root, "2026/06/10/test.md", "2026-06-10");

    const state = loadMemoryState(root);
    assert.deepEqual(state.get("2026/06/10/test.md"), {
      accessed: "2026-06-10",
      count: 2,
      tier: "short",
    });
  });
});

// ── dropFromIndex ─────────────────────────────────────────────────────────

describe("dropFromIndex", () => {
  test("marks an entry as dropped with reason", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "test.md");

    dropFromIndex(root, "2026/06/10/test.md", "evicted");

    const state = loadMemoryState(root);
    assert.equal(state.get("2026/06/10/test.md").dropped, "evicted");
  });
});

// ── getMemoryMeta ─────────────────────────────────────────────────────────

describe("getMemoryMeta", () => {
  test("returns metadata for a known entry from _meta.json", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry.md");
    writeMeta(root, "2026/06/10", {
      "entry.md": { accessed: "2026-06-10", count: 2, tier: "long" },
    });

    const meta = getMemoryMeta(root, "2026/06/10/entry.md");
    assert.deepEqual(meta, {
      accessed: "2026-06-10",
      count: 2,
      tier: "long",
    });
  });

  test("returns defaults for an entry not in any _meta.json", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry.md");

    const meta = getMemoryMeta(root, "2026/06/10/entry.md");
    assert.deepEqual(meta, {
      accessed: "2026-06-10",
      count: 1,
      tier: "short",
    });
  });
});

// ── Self-healing ──────────────────────────────────────────────────────────

describe("self-healing", () => {
  test("lost _meta.json reverts entries to path-date defaults", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry.md");
    writeMeta(root, "2026/06/10", {
      "entry.md": { accessed: "2026-06-10", count: 5, tier: "long" },
    });

    // Confirm custom metadata is loaded initially
    assert.equal(loadMemoryState(root).get("2026/06/10/entry.md").count, 5);

    // Delete _meta.json — simulate corruption or loss
    fs.rmSync(
      path.join(root, ".claude", "memory", "2026/06/10", "_meta.json"),
    );

    // After healing, entry should get backfilled defaults from the .md file
    assert.deepEqual(
      loadMemoryState(root).get("2026/06/10/entry.md"),
      { accessed: "2026-06-10", count: 1, tier: "short" },
    );
  });
});

// ── Scope isolation ───────────────────────────────────────────────────────

describe("scope isolation", () => {
  test("two scopes have independent state", () => {
    const rootA = tmpScope();
    const rootB = tmpScope();

    writeMd(rootA, "2026/06/10", "entry-a.md");
    writeMeta(rootA, "2026/06/10", {
      "entry-a.md": { accessed: "2026-06-10", count: 2, tier: "short" },
    });

    writeMd(rootB, "2026/06/11", "entry-b.md");
    writeMeta(rootB, "2026/06/11", {
      "entry-b.md": { accessed: "2026-06-11", count: 1, tier: "long" },
    });

    const stateA = loadMemoryState(rootA);
    const stateB = loadMemoryState(rootB);

    assert.equal(stateA.size, 1);
    assert.ok(stateA.has("2026/06/10/entry-a.md"));
    assert.ok(!stateA.has("2026/06/11/entry-b.md"));

    assert.equal(stateB.size, 1);
    assert.ok(stateB.has("2026/06/11/entry-b.md"));
    assert.ok(!stateB.has("2026/06/10/entry-a.md"));
  });
});

// ── Promote / demote round-trip ───────────────────────────────────────────

describe("promote / demote round-trip", () => {
  test("saveMemoryMeta can promote and demote tier while preserving other fields", () => {
    const root = tmpScope();
    writeMd(root, "2026/06/10", "entry.md");

    // Promote to long
    saveMemoryMeta(root, "2026/06/10/entry.md", {
      tier: "long",
      count: 3,
      accessed: "2026-06-10",
    });

    const afterPromote = loadMemoryState(root);
    assert.equal(afterPromote.get("2026/06/10/entry.md").tier, "long");
    assert.equal(afterPromote.get("2026/06/10/entry.md").count, 3);

    // Demote back to short (partial patch — count and accessed preserved)
    saveMemoryMeta(root, "2026/06/10/entry.md", { tier: "short" });

    const afterDemote = loadMemoryState(root);
    assert.equal(afterDemote.get("2026/06/10/entry.md").tier, "short");
    assert.equal(afterDemote.get("2026/06/10/entry.md").count, 3);
    assert.equal(
      afterDemote.get("2026/06/10/entry.md").accessed,
      "2026-06-10",
    );
  });
});
