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
  buildContextFromFiles,
  isResume,
  findGitRoot,
  findScopeChain,
  collectChainRuleFiles,
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

describe("isResume", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-resume-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("false when path is falsy", () => {
    assert.equal(isResume(null), false);
    assert.equal(isResume(undefined), false);
    assert.equal(isResume(""), false);
  });

  test("false when file does not exist", () => {
    assert.equal(isResume(path.join(dir, "no-such-file.jsonl")), false);
  });

  test("false when file is empty", () => {
    const f = path.join(dir, "empty.jsonl");
    fs.writeFileSync(f, "");
    assert.equal(isResume(f), false);
  });

  test("false when file is small (<=500 bytes — fresh session)", () => {
    const f = path.join(dir, "small.jsonl");
    fs.writeFileSync(f, "x".repeat(500));
    assert.equal(isResume(f), false);
  });

  test("true when file has content (>500 bytes — resumed session)", () => {
    const f = path.join(dir, "resumed.jsonl");
    fs.writeFileSync(f, "x".repeat(501));
    assert.equal(isResume(f), true);
  });
});

describe("findGitRoot", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-gitroot-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns dir when .git exists at startDir", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    assert.equal(findGitRoot(dir), dir);
  });

  test("walks up to find .git two levels above", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    const deep = path.join(dir, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(findGitRoot(deep), dir);
  });

  test("falls back to startDir when no .git found", () => {
    assert.equal(findGitRoot(dir), dir);
  });
});

describe("findScopeChain", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-scopechain-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkScope(p) {
    fs.mkdirSync(path.join(p, ".claude", "memory"), { recursive: true });
  }

  test("single scope at project root", () => {
    mkScope(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    assert.deepEqual(findScopeChain(dir, dir), [dir]);
  });

  test("two-level nesting", () => {
    mkScope(dir);
    const child = path.join(dir, "child");
    mkScope(child);
    assert.deepEqual(findScopeChain(child, dir), [dir, child]);
  });

  test("three-level nesting", () => {
    mkScope(dir);
    const a = path.join(dir, "a");
    const b = path.join(a, "b");
    mkScope(a);
    mkScope(b);
    assert.deepEqual(findScopeChain(b, dir), [dir, a, b]);
  });

  test("cwd in non-scope subdirectory — walks up to nearest scope", () => {
    mkScope(dir);
    const deep = path.join(dir, "sub", "deep");
    fs.mkdirSync(deep, { recursive: true });
    assert.deepEqual(findScopeChain(deep, dir), [dir]);
  });

  test("no scopes anywhere", () => {
    assert.deepEqual(findScopeChain(dir, dir), []);
  });

  test("project root not a scope, child is", () => {
    const child = path.join(dir, "child");
    mkScope(child);
    assert.deepEqual(findScopeChain(child, dir), [child]);
  });
});

describe("collectChainRuleFiles", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-chain-rules-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("empty chain returns []", () => {
    assert.deepEqual(collectChainRuleFiles([]), []);
  });

  test("single scope with rules", () => {
    const rules = path.join(dir, ".claude", "rules");
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(rules, "a.md"), "a");
    fs.writeFileSync(path.join(rules, "b.md"), "b");
    assert.equal(collectChainRuleFiles([dir]).length, 2);
  });

  test("single scope without rules returns []", () => {
    assert.deepEqual(collectChainRuleFiles([dir]), []);
  });

  test("two scopes with rules — root first, child second", () => {
    const child = path.join(dir, "child");
    const rootRules = path.join(dir, ".claude", "rules");
    const childRules = path.join(child, ".claude", "rules");
    fs.mkdirSync(rootRules, { recursive: true });
    fs.mkdirSync(childRules, { recursive: true });
    fs.writeFileSync(path.join(rootRules, "invariants.md"), "root");
    fs.writeFileSync(path.join(childRules, "invariants.md"), "child");
    fs.writeFileSync(path.join(childRules, "extra.md"), "extra");

    const files = collectChainRuleFiles([dir, child]);
    assert.equal(files.length, 3);
    // Root scope files come first
    assert.ok(files[0].includes(path.join(dir, ".claude", "rules")));
    assert.ok(files[1].includes(path.join(child, ".claude", "rules")));
    assert.ok(files[2].includes(path.join(child, ".claude", "rules")));
  });
});

describe("buildContextFromFiles", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-ctx-files-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("empty files returns null", () => {
    assert.equal(buildContextFromFiles(dir, []), null);
  });

  test("single file", () => {
    const f = path.join(dir, ".claude", "rules", "invariants.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "# Inv\nbody");
    const ctx = buildContextFromFiles(dir, [f]);
    assert.match(ctx, /Contents of .+invariants\.md/);
    assert.match(ctx, /# Inv\nbody/);
  });

  test("two files from different scopes — first file appears first", () => {
    const a = path.join(dir, ".claude", "rules", "a.md");
    const child = path.join(dir, "child", ".claude", "rules", "b.md");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(a, "aaa");
    fs.writeFileSync(child, "bbb");

    const ctx = buildContextFromFiles(dir, [a, child]);
    const aIdx = ctx.indexOf("Contents of");
    const bIdx = ctx.indexOf("Contents of", aIdx + 1);
    assert.ok(bIdx > aIdx, "first file should appear before second");
  });
});

describe("inject-rules integration", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-integ-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("two scopes with rules in both", () => {
    const child = path.join(dir, "child");
    // Create scopes (.claude/memory/)
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
    fs.mkdirSync(path.join(child, ".claude", "memory"), { recursive: true });
    // Rules in both
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(child, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "rules", "root.md"), "# Root");
    fs.writeFileSync(path.join(child, ".claude", "rules", "child.md"), "# Child");

    const chain = findScopeChain(child, dir);
    assert.equal(chain.length, 2);
    const files = collectChainRuleFiles(chain);
    const ctx = buildContextFromFiles(dir, files);
    assert.match(ctx, /root\.md/);
    assert.match(ctx, /child\.md/);
    // Root file appears before child file
    assert.ok(ctx.indexOf("root.md") < ctx.indexOf("child.md"));
  });

  test("root rules only when cwd is project root", () => {
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "rules", "root.md"), "# Root");

    const chain = findScopeChain(dir, dir);
    assert.equal(chain.length, 1);
    assert.equal(chain[0], dir);
  });

  test("no rules in any scope produces empty context", () => {
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
    const chain = findScopeChain(dir, dir);
    assert.equal(chain.length, 1);
    const files = collectChainRuleFiles(chain);
    assert.equal(files.length, 0);
    assert.equal(buildContextFromFiles(dir, files), null);
  });
});
