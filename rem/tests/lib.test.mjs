/**
 * Tests for rem/lib.mjs — index parsing, constants, file collection, state, and project root.
 * Run: node --test cc-market/rem/tests/lib.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseIndexEntry,
  formatIndexEntry,
  updateIndexAccessed,
  parseIndex,
  INDEX_HEADER,
  MAX_ENTRIES,
  STALE_DAYS,
  DAY_MS,
  collectMemoryFiles,
  loadState,
  saveState,
  appendEvent,
  stateFile,
  findProjectRoot,
} from "../lib.mjs";

// ── Index parsing ──────────────────────────────────────────────────────────────

describe("parseIndexEntry", () => {
  test("parses valid entry line", () => {
    const line = "- [2026-06-03 Test Entry](../memory/2026-06-03/test-entry.md) — `created: 2026-06-03, accessed: 2026-06-03`";
    const entry = parseIndexEntry(line);
    assert.equal(entry.date, "2026-06-03");
    assert.equal(entry.title, "Test Entry");
    assert.equal(entry.path, "2026-06-03/test-entry.md");
    assert.equal(entry.created, "2026-06-03");
    assert.equal(entry.accessed, "2026-06-03");
  });

  test("returns null for non-entry line", () => {
    assert.equal(parseIndexEntry(""), null);
    assert.equal(parseIndexEntry("# Header"), null);
    assert.equal(parseIndexEntry("Some random text"), null);
  });

  test("returns null for markdown link that is not an index entry", () => {
    assert.equal(parseIndexEntry("- [link](some/other/file.md)"), null);
  });
});

describe("formatIndexEntry", () => {
  test("formats entry correctly", () => {
    const entry = {
      date: "2026-06-03",
      title: "Test Entry",
      path: "2026-06-03/test-entry.md",
      created: "2026-06-03",
      accessed: "2026-06-03",
    };
    const line = formatIndexEntry(entry);
    assert.ok(line.includes("[2026-06-03 Test Entry]"));
    assert.ok(line.includes("../memory/2026-06-03/test-entry.md"));
    assert.ok(line.includes("created: 2026-06-03"));
    assert.ok(line.includes("accessed: 2026-06-03"));
  });
});

describe("updateIndexAccessed", () => {
  test("updates accessed date in matching entry", () => {
    const index = [
      "# Memory Index",
      "",
      "- [2026-06-03 Test Entry](../memory/2026-06-03/test-entry.md) — `created: 2026-06-03, accessed: 2026-06-01`",
      "- [2026-06-02 Other](../memory/2026-06-02/other.md) — `created: 2026-06-02, accessed: 2026-06-02`",
      "",
    ].join("\n");
    const result = updateIndexAccessed(index, "2026-06-03/test-entry.md", "2026-06-03");
    assert.notEqual(result, null);
    assert.ok(result.includes("accessed: 2026-06-03"));
    assert.ok(!result.includes("accessed: 2026-06-01"));
    // Other entry unchanged
    assert.ok(result.includes("accessed: 2026-06-02"));
  });

  test("returns null when path not found in index", () => {
    const index = [
      "# Memory Index",
      "- [2026-06-03 Test](../memory/2026-06-03/test.md) — `created: 2026-06-03, accessed: 2026-06-03`",
    ].join("\n");
    assert.equal(updateIndexAccessed(index, "nonexistent/file.md", "2026-06-03"), null);
  });

  test("handles paths with regex special characters", () => {
    const index = [
      "- [2026-06-03 Special+Chars](../memory/2026-06-03/special+chars.md) — `created: 2026-06-03, accessed: 2026-06-01`",
    ].join("\n");
    const result = updateIndexAccessed(index, "2026-06-03/special+chars.md", "2026-06-03");
    assert.notEqual(result, null);
    assert.ok(result.includes("accessed: 2026-06-03"));
  });
});

describe("parseIndex", () => {
  test("separates header and entries", () => {
    const content = [
      "# Memory Index",
      "",
      "<!-- comment -->",
      "",
      "- [2026-06-03 Entry A](../memory/2026-06-03/a.md) — `created: 2026-06-03, accessed: 2026-06-03`",
      "- [2026-06-02 Entry B](../memory/2026-06-02/b.md) — `created: 2026-06-02, accessed: 2026-06-02`",
    ].join("\n");
    const { header, entries } = parseIndex(content);
    assert.ok(header.length > 0);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].title, "Entry A");
    assert.equal(entries[1].title, "Entry B");
  });

  test("handles index with only entries (no header)", () => {
    const content = [
      "- [2026-06-03 Entry](../memory/2026-06-03/entry.md) — `created: 2026-06-03, accessed: 2026-06-03`",
    ].join("\n");
    const { header, entries } = parseIndex(content);
    assert.equal(header.length, 0);
    assert.equal(entries.length, 1);
  });

  test("handles index with no entries", () => {
    const content = INDEX_HEADER.trim();
    const { header, entries } = parseIndex(content);
    assert.ok(header.length > 0);
    assert.equal(entries.length, 0);
  });
});

// ── INDEX_HEADER ───────────────────────────────────────────────────────────────

test("INDEX_HEADER is non-empty", () => {
  assert.ok(INDEX_HEADER.length > 50);
  assert.ok(INDEX_HEADER.includes("# Memory Index"));
});

// ── Constants ──────────────────────────────────────────────────────────────────

test("MAX_ENTRIES is 20", () => assert.equal(MAX_ENTRIES, 20));
test("STALE_DAYS is 90", () => assert.equal(STALE_DAYS, 90));
test("DAY_MS equals 86400000", () => assert.equal(DAY_MS, 86400000));

// ── File collection ────────────────────────────────────────────────────────────

describe("collectMemoryFiles", () => {
  test("returns empty array for non-existent directory", () => {
    assert.deepEqual(collectMemoryFiles("/nonexistent/path/xyz"), []);
  });
});

// ── State management ───────────────────────────────────────────────────────────

describe("loadState / saveState / appendEvent", () => {
  let savedState = null;

  beforeEach(() => {
    // Save the real state file if it exists (the test reads from
    // process.cwd()/.claude/.rem-state.json which is symlinked to
    // ~/.claude/.rem-state.json — the active session may have data).
    if (fs.existsSync(stateFile)) {
      savedState = fs.readFileSync(stateFile, "utf8");
    }
  });

  afterEach(() => {
    if (savedState) {
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(stateFile, savedState, "utf8");
      savedState = null;
    }
  });

  test("loadState returns default structure when file missing", () => {
    // Remove the state file so we test the default path
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    const state = loadState();
    assert.ok("hook" in state);
    assert.ok("prune" in state);
    assert.equal(state.hook.stopCount, 0);
    assert.equal(state.hook.remPending, false);
    assert.equal(state.hook.remDone, false);
    assert.equal(state.prune.lastPruneAt, 0);
    assert.ok(Array.isArray(state.prune.events));
  });
});

// ── findProjectRoot ────────────────────────────────────────────────────────────

describe("findProjectRoot", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (savedEnv) process.env.CLAUDE_PROJECT_DIR = savedEnv;
    else delete process.env.CLAUDE_PROJECT_DIR;
  });

  test("returns CLAUDE_PROJECT_DIR when it has .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      fs.mkdirSync(path.join(tmp, "sub"));
      process.env.CLAUDE_PROJECT_DIR = path.join(tmp, "sub");
      assert.equal(findProjectRoot(), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns CLAUDE_PROJECT_DIR unchanged when no .git found", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
    try {
      // No .git anywhere
      process.env.CLAUDE_PROJECT_DIR = tmp;
      assert.equal(findProjectRoot(), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns dir itself when it has .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      process.env.CLAUDE_PROJECT_DIR = tmp;
      assert.equal(findProjectRoot(), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("walks up multiple levels to find .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      const deep = path.join(tmp, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      process.env.CLAUDE_PROJECT_DIR = deep;
      assert.equal(findProjectRoot(), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
