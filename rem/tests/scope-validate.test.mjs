/**
 * Tests for rem/scripts/scope-validate.mjs — scope isolation and intermediate file integrity.
 * Run: node --test cc-market/rem/tests/scope-validate.test.mjs
 *
 * The script has no exported functions, so we drive it via execFileSync with
 * CLAUDE_PROJECT_DIR pointed at temp directories containing the scope artifacts.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Resolve relative to this test file so it works regardless of cwd
// (root config repo vs. cc-market's own pre-commit hook).
const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "scope-validate.mjs"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpDirs = [];

/**
 * Create an isolated temp directory that looks like a project root (has .git).
 * Registered for auto-cleanup in the `after` hook.
 */
function freshDir() {
  const d = mkdtempSync(join(os.tmpdir(), "scope-val-"));
  tmpDirs.push(d);
  // .git marker so findProjectRoot resolves here
  mkdirSync(join(d, ".git"), { recursive: true });
  return d;
}

/**
 * Build a valid scope structure inside rootDir.
 *
 * Options (all default true):
 *   withMd       — create a .md memory file in YYYY/MM/DD/
 *   withMeta     — create _meta.json in the date dir
 *   withIndex    — create .claude/rules/MEMORY.md
 *   corruptMeta  — write invalid JSON for _meta.json (implies withMeta=false
 *                  since the existence check and corruption check are distinct)
 */
function setupScope(rootDir, opts = {}) {
  const {
    withMd = true,
    withMeta = true,
    withIndex = true,
    corruptMeta = false,
  } = opts;

  const dateDir = join(rootDir, ".claude", "memory", "2026", "06", "11");
  mkdirSync(dateDir, { recursive: true });

  if (withMd) {
    writeFileSync(
      join(dateDir, "test-entry.md"),
      [
        "---",
        "name: Test Entry",
        "description: A scope validation test entry",
        "---",
        "",
        "# Test Entry",
        "",
        "Content for scope-validate tests.",
      ].join("\n"),
      "utf8"
    );
  }

  if (corruptMeta) {
    writeFileSync(join(dateDir, "_meta.json"), "{bad", "utf8");
  } else if (withMeta) {
    writeFileSync(
      join(dateDir, "_meta.json"),
      JSON.stringify({
        "2026/06/11/test-entry.md": {
          accessed: "2026-06-11",
          count: 1,
          tier: "short",
        },
      }) + "\n",
      "utf8"
    );
  }

  if (withIndex) {
    const rulesDir = join(rootDir, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, "MEMORY.md"),
      "# Memory Index\n\n_(no entries)_\n",
      "utf8"
    );
  }
}

/**
 * Run scope-validate.mjs inside rootDir with the given args.
 * Returns { stdout, status }. For non-zero exits the error is caught and
 * status is extracted rather than thrown.
 */
function runValidate(rootDir, args = ["--check"]) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e) {
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      status: e.status,
    };
  }
}

after(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scope-validate --check", () => {
  test("clean scope exits 0", () => {
    const root = freshDir();
    setupScope(root);

    const { stdout, status } = runValidate(root, ["--check"]);

    assert.equal(status, 0);
    assert.ok(stdout.includes("clean"), "expected 'clean' in output");
  });

  test("missing _meta.json reported", () => {
    const root = freshDir();
    setupScope(root, { withMeta: false });

    const { stdout, status } = runValidate(root, ["--check"]);

    // missing _meta.json is warn level, not error -> exit 0
    assert.equal(status, 0);
    assert.ok(
      stdout.includes("missing _meta.json"),
      "expected 'missing _meta.json' in output"
    );
  });

  test("missing MEMORY.md reported", () => {
    const root = freshDir();
    setupScope(root, { withIndex: false });

    const { stdout, status } = runValidate(root, ["--check"]);

    // missing MEMORY.md is warn level, not error -> exit 0
    assert.equal(status, 0);
    assert.ok(
      stdout.includes("MEMORY.md missing"),
      "expected 'MEMORY.md missing' in output"
    );
  });

  test("dangling migrated→ tombstone reported", () => {
    const root = freshDir();
    setupScope(root);
    // tombstone points at a child scope that does not exist
    const metaFile = join(root, ".claude", "memory", "2026", "06", "11", "_meta.json");
    writeFileSync(
      metaFile,
      JSON.stringify({ "gone.md": { accessed: "2026-06-11", count: 1, tier: "short", dropped: "migrated→ghost-mod" } }) + "\n",
      "utf8"
    );

    const { stdout, status } = runValidate(root, ["--check"]);

    // warn level -> exit 0
    assert.equal(status, 0);
    assert.ok(
      stdout.includes("dangling migrated→ tombstone"),
      "expected dangling tombstone warning"
    );
  });

  test("corrupt _meta.json detected", () => {
    const root = freshDir();
    setupScope(root, { corruptMeta: true });

    const { stdout, status } = runValidate(root, ["--check"]);

    // corrupt _meta.json is error level -> exit 1
    assert.equal(status, 1);
    assert.ok(
      stdout.includes("corrupt _meta.json"),
      "expected 'corrupt _meta.json' in output"
    );
  });
});

describe("scope-validate --fix", () => {
  test("creates missing _meta.json", () => {
    const root = freshDir();
    setupScope(root, { withMeta: false, withIndex: true });

    const { stdout, status } = runValidate(root, ["--fix"]);

    assert.equal(status, 0);
    assert.ok(
      stdout.includes("fixes applied"),
      "expected 'fixes applied' in output"
    );

    // Verify the file was actually created
    const metaFile = join(
      root,
      ".claude",
      "memory",
      "2026",
      "06",
      "11",
      "_meta.json"
    );
    assert.ok(existsSync(metaFile), "_meta.json should exist after --fix");

    // And it should be valid JSON
    const content = readFileSync(metaFile, "utf8");
    assert.doesNotThrow(() => JSON.parse(content), "created _meta.json should be valid JSON");
  });

  test("rebuilds missing MEMORY.md", () => {
    const root = freshDir();
    setupScope(root, { withMeta: true, withIndex: false });

    const { stdout, status } = runValidate(root, ["--fix"]);

    assert.equal(status, 0);
    assert.ok(
      stdout.includes("fixes applied"),
      "expected 'fixes applied' in output"
    );

    // Verify MEMORY.md was rebuilt
    const indexFile = join(root, ".claude", "rules", "MEMORY.md");
    assert.ok(existsSync(indexFile), "MEMORY.md should exist after --fix");

    // Verify it contains reasonable content
    const content = readFileSync(indexFile, "utf8");
    // The index header is written by rebuildIndex
    assert.ok(
      content.includes("Memory Index"),
      "rebuilt MEMORY.md should contain 'Memory Index'"
    );
    // Our test entry should appear — even without _meta.json, loadMemoryState
    // backfills from the .md file on disk
    assert.ok(
      content.includes("2026-06-11") || content.includes("test-entry"),
      "rebuilt MEMORY.md should reference the memory entry"
    );
  });
});
