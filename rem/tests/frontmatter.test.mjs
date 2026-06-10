/**
 * Tests for rem/lib.mjs — frontmatter helpers.
 * Run: node --test cc-market/rem/tests/frontmatter.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseFrontmatter,
  getField,
  setField,
  getTier,
  setTier,
  hasAllFields,
  stampMissingFields,
  bumpAccessed,
  getAccessCount,
} from "../lib.mjs";

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

  test("increments access_count when accessed date advances", () => {
    const content = "---\naccessed: 2026-01-01\n---\nbody";
    const result = bumpAccessed(content, "2026-06-03");
    assert.ok(result.includes("access_count: 2"));
  });

  test("does not increment access_count when accessed date is unchanged", () => {
    const content = "---\naccessed: 2026-06-03\naccess_count: 2\n---\nbody";
    const result = bumpAccessed(content, "2026-06-03");
    assert.ok(result.includes("access_count: 2"));
    assert.ok(!result.includes("access_count: 3"));
  });

  test("compounds across repeated date advances", () => {
    let content = "---\naccessed: 2026-01-01\naccess_count: 2\n---\nbody";
    content = bumpAccessed(content, "2026-06-03");
    assert.ok(content.includes("access_count: 3"));
  });
});

// ── getAccessCount ───────────────────────────────────────────────────────────────

describe("getAccessCount", () => {
  test("defaults to 1 when access_count field is absent", () => {
    const content = "---\naccessed: 2026-01-01\n---\nbody";
    assert.equal(getAccessCount(content), 1);
  });

  test("returns the parsed access_count value", () => {
    const content = "---\naccessed: 2026-01-01\naccess_count: 4\n---\nbody";
    assert.equal(getAccessCount(content), 4);
  });
});
