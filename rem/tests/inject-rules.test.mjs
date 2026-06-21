/**
 * Tests for rem/scripts/inject-rules.js — Codex .claude/rules injection.
 * Run: node --test cc-market/rem/tests/inject-rules.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  isCodexHost,
  collectRuleFiles,
  buildRulesContext,
} from "../scripts/inject-rules.js";

describe("isCodexHost", () => {
  test("true when plugin root lives under .codex", () => {
    assert.equal(
      isCodexHost({ CLAUDE_PLUGIN_ROOT: "/home/u/.codex/plugins/cache/cc-market/rem/1.0.0" }),
      true,
    );
  });

  test("false when plugin root lives under .claude", () => {
    assert.equal(
      isCodexHost({ CLAUDE_PLUGIN_ROOT: "/home/u/.claude/plugins/cache/cc-market/rem/1.0.0" }),
      false,
    );
  });

  test("true when CODEX_HOME set and no .claude plugin root", () => {
    assert.equal(isCodexHost({ CODEX_HOME: "/home/u/.codex" }), true);
  });

  test("claude plugin root wins over a stray CODEX_HOME", () => {
    assert.equal(
      isCodexHost({
        CLAUDE_PLUGIN_ROOT: "/home/u/.claude/plugins/cache/cc-market/rem/1.0.0",
        CODEX_HOME: "/home/u/.codex",
      }),
      false,
    );
  });

  test("false when no signal present", () => {
    assert.equal(isCodexHost({}), false);
  });
});

describe("collectRuleFiles", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-rules-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns [] when no .claude/rules dir", () => {
    assert.deepEqual(collectRuleFiles(dir), []);
  });

  test("collects nested .md files, sorted, ignores non-md", () => {
    const rules = path.join(dir, ".claude", "rules");
    fs.mkdirSync(path.join(rules, "rem"), { recursive: true });
    fs.writeFileSync(path.join(rules, "b.md"), "b");
    fs.writeFileSync(path.join(rules, "a.md"), "a");
    fs.writeFileSync(path.join(rules, "rem", "c.md"), "c");
    fs.writeFileSync(path.join(rules, "notes.txt"), "ignore me");

    const rel = collectRuleFiles(dir).map((f) => path.relative(rules, f));
    assert.deepEqual(rel, ["a.md", "b.md", path.join("rem", "c.md")]);
  });
});

describe("buildRulesContext", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-rules-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when no rules", () => {
    assert.equal(buildRulesContext(dir), null);
  });

  test("concatenates files with a header path per file", () => {
    const rules = path.join(dir, ".claude", "rules");
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(rules, "invariants.md"), "# Inv\nbody");

    const ctx = buildRulesContext(dir);
    assert.match(ctx, /\.claude[\\/]rules[\\/]invariants\.md/);
    assert.match(ctx, /# Inv\nbody/);
  });
});
