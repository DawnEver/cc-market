/**
 * Tests for rem/scripts/task-engine.js — CLI dispatch behavior.
 * Run: node --test cc-market/rem/tests/task-engine-cli.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ENGINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "task-engine.js"
);

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-engine-cli-"));
  // A directory with .claude/memory/ qualifies as a scope.
  fs.mkdirSync(path.join(tmp, ".claude", "memory"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...args) {
  return execFileSync(process.execPath, [ENGINE, ...args], {
    cwd: tmp,
    encoding: "utf8",
  });
}

function manualFilesExist() {
  const found = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "manual.md") found.push(full);
    }
  }
  walk(path.join(tmp, ".claude", "memory"));
  return found;
}

describe("task-engine CLI dispatch", () => {
  test("`check` runs a report and never creates a manual task", () => {
    const out = run("check");
    // Empty scope → report says no tasks, NOT an "Added: MANUAL-..." line.
    assert.doesNotMatch(out, /Added: MANUAL-/);
    assert.deepEqual(manualFilesExist(), []);
  });

  test("`report` runs a report and never creates a manual task", () => {
    const out = run("report");
    assert.doesNotMatch(out, /Added: MANUAL-/);
    assert.deepEqual(manualFilesExist(), []);
  });

  test("explicit add still creates a manual task", () => {
    const out = run("add", "--summary", "real task");
    assert.match(out, /Added: MANUAL-/);
    assert.equal(manualFilesExist().length, 1);
  });
});
