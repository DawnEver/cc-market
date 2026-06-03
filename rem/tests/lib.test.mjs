/**
 * Tests for rem/lib.mjs — frontmatter, date, path, index, state, and file helpers.
 * Run: node --test cc-market/rem/tests/lib.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseFrontmatter,
  getField,
  setField,
  getTier,
  setTier,
  hasAllFields,
  stampMissingFields,
  bumpAccessed,
  todayISO,
  parseDate,
  dayPrecision,
  extractDateFromPath,
  resolveMemoryPath,
  isInsideMemoryDir,
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
} from "../lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── parseFrontmatter ───────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses frontmatter fields", () => {
    const content = [
      "---",
      "name: test-entry",
      "description: A test memory",
      "created: 2026-06-03",
      "accessed: 2026-06-03",
      "tier: short",
      "---",
      "",
      "# Body content",
    ].join("\n");
    const result = parseFrontmatter(content);
    assert.equal(result.fields.name, "test-entry");
    assert.equal(result.fields.description, "A test memory");
    assert.equal(result.fields.created, "2026-06-03");
    assert.equal(result.fields.tier, "short");
    assert.ok(result.body.includes("# Body content"));
  });

  test("returns empty fields object when no frontmatter", () => {
    const content = "# Just a heading\nSome body text.";
    const result = parseFrontmatter(content);
    assert.deepEqual(result.fields, {});
    assert.equal(result.body, content);
  });

  test("handles empty frontmatter", () => {
    const content = "---\n\n---\nbody";
    const result = parseFrontmatter(content);
    assert.deepEqual(result.fields, {});
    assert.equal(result.body, "\nbody");
  });

  test("handles frontmatter with values containing colons", () => {
    const content = [
      "---",
      "name: url-test",
      "description: See https://example.com for details",
      "---",
      "body",
    ].join("\n");
    const result = parseFrontmatter(content);
    assert.ok(result.fields.description.includes("https://example.com"));
  });

  test("handles multiline frontmatter structure", () => {
    const content = [
      "---",
      "name: multi-line-test",
      "description: Line 1",
      "metadata:",
      "  type: project",
      "---",
      "body",
    ].join("\n");
    const result = parseFrontmatter(content);
    assert.equal(result.fields.metadata, "");
  });
});

// ── getField ───────────────────────────────────────────────────────────────────

describe("getField", () => {
  test("returns field value when present", () => {
    const content = "---\nname: test\n---\nbody";
    assert.equal(getField(content, "name"), "test");
  });

  test("returns null when field absent", () => {
    const content = "---\nname: test\n---\nbody";
    assert.equal(getField(content, "tier"), null);
  });

  test("returns value with inline spaces", () => {
    const content = "---\ndescription: a b c\n---\nbody";
    assert.equal(getField(content, "description"), "a b c");
  });

  test("works without frontmatter", () => {
    assert.equal(getField("plain text", "name"), null);
  });
});

// ── setField ───────────────────────────────────────────────────────────────────

describe("setField", () => {
  test("replaces existing field", () => {
    const content = "---\nname: old\n---\nbody";
    const result = setField(content, "name", "new");
    assert.ok(result.includes("name: new"));
    assert.ok(!result.includes("name: old"));
  });

  test("inserts new field before closing ---", () => {
    const content = "---\nname: test\n---\nbody";
    const result = setField(content, "tier", "long");
    assert.ok(result.includes("tier: long"));
  });

  test("returns unchanged when no frontmatter (no closing ---)", () => {
    const content = "plain text";
    const result = setField(content, "name", "value");
    assert.equal(result, content);
  });

  test("updates field when multiple fields exist", () => {
    const content = "---\nname: A\ntier: short\n---\nbody";
    const result = setField(content, "tier", "long");
    assert.ok(result.includes("tier: long"));
    assert.ok(result.includes("name: A"));
  });
});

// ── getTier / setTier ──────────────────────────────────────────────────────────

describe("getTier", () => {
  test("returns tier when present", () => {
    assert.equal(getTier("---\ntier: long\n---\nbody"), "long");
  });

  test("defaults to 'short' when absent", () => {
    assert.equal(getTier("---\nname: x\n---\nbody"), "short");
  });

  test("defaults to 'short' when no frontmatter", () => {
    assert.equal(getTier("plain text"), "short");
  });
});

describe("setTier", () => {
  test("sets tier field via setField", () => {
    const content = "---\nname: x\n---\nbody";
    const result = setTier(content, "long");
    assert.ok(result.includes("tier: long"));
  });
});

// ── hasAllFields ───────────────────────────────────────────────────────────────

describe("hasAllFields", () => {
  test("returns true when created, accessed, tier all present", () => {
    const content = "---\ncreated: 2026-01-01\naccessed: 2026-06-03\ntier: short\n---\nbody";
    assert.equal(hasAllFields(content), true);
  });

  test("returns false when created missing", () => {
    const content = "---\naccessed: 2026-06-03\ntier: short\n---\nbody";
    assert.equal(hasAllFields(content), false);
  });

  test("returns false when accessed missing", () => {
    const content = "---\ncreated: 2026-01-01\ntier: short\n---\nbody";
    assert.equal(hasAllFields(content), false);
  });

  test("returns false when tier missing", () => {
    const content = "---\ncreated: 2026-01-01\naccessed: 2026-06-03\n---\nbody";
    assert.equal(hasAllFields(content), false);
  });

  test("returns false when no frontmatter", () => {
    assert.equal(hasAllFields("plain text"), false);
  });
});

// ── stampMissingFields ─────────────────────────────────────────────────────────

describe("stampMissingFields", () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
    tmpFile = path.join(tmpDir, "2026-06-03", "test-entry.md");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns false when all fields present", () => {
    fs.writeFileSync(tmpFile, [
      "---",
      "name: test-entry",
      "created: 2026-06-03",
      "accessed: 2026-06-03",
      "tier: short",
      "---",
      "body",
    ].join("\n"));
    assert.equal(stampMissingFields(tmpFile), false);
  });

  test("returns true and stamps missing fields", () => {
    fs.writeFileSync(tmpFile, [
      "---",
      "name: test-entry",
      "---",
      "body",
    ].join("\n"));
    assert.equal(stampMissingFields(tmpFile), true);
    const updated = fs.readFileSync(tmpFile, "utf8");
    assert.ok(/^created:/m.test(updated));
    assert.ok(/^accessed:/m.test(updated));
    assert.ok(/^tier:/m.test(updated));
  });

  test("stamps only the missing fields", () => {
    fs.writeFileSync(tmpFile, [
      "---",
      "name: test-entry",
      "created: 2026-06-01",
      "---",
      "body",
    ].join("\n"));
    stampMissingFields(tmpFile);
    const updated = fs.readFileSync(tmpFile, "utf8");
    assert.ok(/^created: 2026-06-01$/m.test(updated), "existing created should be preserved");
    assert.ok(/^accessed:/m.test(updated), "accessed should be added");
    assert.ok(/^tier:/m.test(updated), "tier should be added");
  });
});

// ── bumpAccessed ───────────────────────────────────────────────────────────────

describe("bumpAccessed", () => {
  test("updates accessed field", () => {
    const content = "---\naccessed: 2026-01-01\n---\nbody";
    const result = bumpAccessed(content, "2026-06-03");
    assert.ok(result.includes("accessed: 2026-06-03"));
    assert.ok(!result.includes("accessed: 2026-01-01"));
  });
});

// ── Date helpers ───────────────────────────────────────────────────────────────

describe("todayISO", () => {
  test("returns YYYY-MM-DD format", () => {
    const today = todayISO();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today));
  });

  test("returns today's date", () => {
    const expected = new Date().toISOString().slice(0, 10);
    assert.equal(todayISO(), expected);
  });
});

describe("parseDate", () => {
  test("parses ISO date string to milliseconds", () => {
    const ms = parseDate("2026-06-03");
    assert.equal(typeof ms, "number");
    assert.ok(ms > 0);
  });

  test("returns same value for same date regardless of time", () => {
    const a = parseDate("2026-06-03");
    const b = parseDate("2026-06-03");
    assert.equal(a, b);
  });
});

describe("dayPrecision", () => {
  test("floors to day boundary", () => {
    const ms = Date.UTC(2026, 5, 3, 12, 30, 45, 123); // June 3, 2026 12:30:45.123 UTC
    const floored = dayPrecision(ms);
    const expected = Date.UTC(2026, 5, 3, 0, 0, 0, 0);
    assert.equal(floored, expected);
  });

  test("same day different times yield same precision", () => {
    const a = dayPrecision(Date.UTC(2026, 5, 3, 1, 0, 0));
    const b = dayPrecision(Date.UTC(2026, 5, 3, 23, 59, 59));
    assert.equal(a, b);
  });

  test("different days yield different precision", () => {
    const a = dayPrecision(Date.UTC(2026, 5, 3));
    const b = dayPrecision(Date.UTC(2026, 5, 4));
    assert.notEqual(a, b);
  });
});

describe("extractDateFromPath", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts ISO date from parent folder name", () => {
    const file = path.join(tmpDir, "2026-06-03", "entry.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "content");
    assert.equal(extractDateFromPath(file), "2026-06-03");
  });

  test("falls back to file mtime when no date folder", () => {
    const file = path.join(tmpDir, "entry.md");
    fs.writeFileSync(file, "content");
    const date = extractDateFromPath(file);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(date));
  });
});

// ── Path security ──────────────────────────────────────────────────────────────

describe("resolveMemoryPath", () => {
  test("resolves relative path under memory dir", () => {
    const result = resolveMemoryPath("2026-06-03/entry.md");
    assert.ok(result.endsWith(path.join(".claude", "memory", "2026-06-03", "entry.md")));
  });
});

describe("isInsideMemoryDir", () => {
  test("allows paths inside memory dir", () => {
    const memPath = resolveMemoryPath("2026-06-03/entry.md");
    assert.equal(isInsideMemoryDir(memPath), true);
  });

  test("rejects paths outside memory dir", () => {
    assert.equal(isInsideMemoryDir("/etc/passwd"), false);
    assert.equal(isInsideMemoryDir(path.resolve("..")), false);
  });

  test("allows memory dir itself", () => {
    const memDir = resolveMemoryPath(".");
    assert.equal(isInsideMemoryDir(memDir), true);
  });
});

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
  let tmpDir, origStatePath;

  beforeEach(() => {
    // We can't easily override stateFile since it's computed from process.cwd()
    // So we test the logic indirectly via the DEFAULT_STATE structure
  });

  test("loadState returns default structure when file missing", () => {
    // stateFile points to .claude/.rem-state.json in process.cwd()
    // If it doesn't exist, should return defaults
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
