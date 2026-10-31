/**
 * Tests for rem/lib.mjs — constants, file collection, state, and project root.
 * Run: node --test cc-market/rem/tests/lib.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  INDEX_HEADER,
  DAY_MS,
  collectMemoryFiles,
  loadState,
  stateFile,
  findProjectRoot,
  isScopeIgnored,
  findAllScopes,
  findChildScopes,
} from "../scripts/lib.mjs";

// ── INDEX_HEADER ───────────────────────────────────────────────────────────────

test("INDEX_HEADER is non-empty", () => {
  assert.ok(INDEX_HEADER.length > 50);
  assert.ok(INDEX_HEADER.includes("# Memory Index"));
});

// ── Constants ──────────────────────────────────────────────────────────────────

test("DAY_MS equals 86400000", () => assert.equal(DAY_MS, 86400000));

// ── File collection ────────────────────────────────────────────────────────────

describe("collectMemoryFiles", () => {
  test("returns empty array for non-existent directory", () => {
    assert.deepEqual(collectMemoryFiles("/nonexistent/path/xyz"), []);
  });
});

// ── State management ───────────────────────────────────────────────────────────

describe("loadState", () => {
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
    assert.ok(!("prune" in state));
    assert.equal(state.hook.stopCount, 0);
    assert.equal(state.hook.remPending, false);
    assert.equal(state.hook.remDone, false);
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

// ── Scope ignore ────────────────────────────────────────────────────────────────

describe("isScopeIgnored", () => {
  test("no patterns → never ignored", () => {
    assert.equal(isScopeIgnored("node_modules", "node_modules", []), false);
    assert.equal(isScopeIgnored("foo", "foo", undefined), false);
  });

  test("bare name matches basename exactly", () => {
    assert.equal(isScopeIgnored("vendor", "a/b/vendor", ["vendor"]), true);
    assert.equal(isScopeIgnored("vendored", "vendored", ["vendor"]), false);
  });

  test("glob on basename", () => {
    assert.equal(isScopeIgnored("test-utils", "x/test-utils", ["test-*"]), true);
    assert.equal(isScopeIgnored("utils", "utils", ["test-*"]), false);
  });

  test("pattern with slash matches relative path", () => {
    assert.equal(isScopeIgnored("docs", "packages/docs", ["packages/docs"]), true);
    assert.equal(isScopeIgnored("docs", "other/docs", ["packages/docs"]), false);
  });

  test("slash pattern with glob", () => {
    assert.equal(isScopeIgnored("e2e", "apps/web/e2e", ["apps/*/e2e"]), true);
  });
});

describe("findAllScopes / findChildScopes ignore", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-scopes-"));
    for (const d of ["keep", "skipme", "nested/deep"]) {
      fs.mkdirSync(path.join(tmp, d, ".claude", "memory"), { recursive: true });
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("findAllScopes skips ignored dirs by name", () => {
    const scopes = findAllScopes(tmp, ["skipme"]);
    assert.ok(scopes.includes(path.join(tmp, "keep")));
    assert.ok(!scopes.some((s) => s.includes("skipme")));
  });

  test("findAllScopes without ignore includes all", () => {
    const scopes = findAllScopes(tmp, []);
    assert.ok(scopes.some((s) => s.endsWith("skipme")));
  });

  test("ignoring a parent prunes its descendants", () => {
    const scopes = findAllScopes(tmp, ["nested"]);
    assert.ok(!scopes.some((s) => s.includes("nested")));
  });

  test("findChildScopes honors ignore", () => {
    const children = findChildScopes(tmp, ["skipme"]);
    assert.ok(!children.some((s) => s.includes("skipme")));
    assert.ok(children.some((s) => s.endsWith("keep")));
  });
});
