/**
 * All memory is gathered at the repo root (user ruling 2026-11-16: the task system replaced
 * scope-split). Writes never land in a child scope; one decline of crystallize is permanent.
 * Run: node --test rem/tests/memory-root.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isInsideDir, crystallizeDue, CRYSTALLIZE_ADVISORY } from "../scripts/lib.mjs";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

describe("isInsideDir", () => {
  test("true for descendant, false for traversal/sibling", () => {
    assert.equal(isInsideDir("/a/b", "/a/b/c/d.md"), true);
    assert.equal(isInsideDir("/a/b", "/a/b"), true);
    assert.equal(isInsideDir("/a/b", "/a/bb/c.md"), false);
    assert.equal(isInsideDir("/a/b", "/a/b/../x.md"), false);
  });
});

describe("remember writes at the root", () => {
  test("from a child directory that holds an older child scope, the entry lands in the root's memory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-root-"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    const child = path.join(root, "pkg", "mod");
    fs.mkdirSync(path.join(child, ".claude", "memory"), { recursive: true });
    fs.mkdirSync(path.join(root, ".claude", "memory"), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "remember.js"), "--name", "a-fact", "--type", "project",
      "--body", "a fact"], { cwd: child, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: child } });
    assert.equal(r.status, 0, r.stderr);
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    assert.equal(walk(path.join(root, ".claude", "memory")).filter(f => f.endsWith("a-fact.md")).length, 1);
    assert.equal(walk(path.join(child, ".claude", "memory")).length, 0, "PLANTED CONTROL: the child scope is never written");
  });

  test("--scope is retired", () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "remember.js"), "--help"], { encoding: "utf8" });
    assert.ok(!`${r.stdout}${r.stderr}`.includes("--scope"));
  });
});

describe("one decline of crystallize is permanent", () => {
  test("below the advisory it is never due", () => assert.equal(crystallizeDue(CRYSTALLIZE_ADVISORY - 1, false), false));
  test("PLANTED CONTROL: at the advisory with no decline it is due", () => assert.equal(crystallizeDue(CRYSTALLIZE_ADVISORY, false), true));
  test("after a decline it is never due again, however many entries accrue", () => {
    assert.equal(crystallizeDue(6051, true), false);
    assert.equal(crystallizeDue(6051 + 100 * CRYSTALLIZE_ADVISORY, true), false);
  });
});
