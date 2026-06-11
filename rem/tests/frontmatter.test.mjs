/**
 * Tests for rem/lib.mjs — frontmatter helpers.
 * Run: node --test cc-market/rem/tests/frontmatter.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseFrontmatter,
  getField,
  setField,
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

