/**
 * Tests for rem/lib.mjs — date helpers and path security.
 * Run: node --test cc-market/rem/tests/date-path.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  todayISO,
  parseDate,
  dayPrecision,
  dateToPath,
  extractDateFromPath,
  resolveMemoryPath,
  isInsideMemoryDir,
} from "../lib.mjs";

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

describe("dateToPath", () => {
  test("converts ISO date to path", () => {
    assert.equal(dateToPath("2026-06-07"), "2026/06/07");
  });
  test("handles Date object", () => {
    assert.ok(dateToPath(new Date("2026-06-07")).endsWith("06/07"));
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

  test("extracts from YYYY/MM/DD path", () => {
    const file = path.join(tmpDir, "2026", "06", "03", "entry.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "content");
    assert.equal(extractDateFromPath(file), "2026-06-03");
  });

  test("extracts from legacy YYYY-MM-DD path", () => {
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
