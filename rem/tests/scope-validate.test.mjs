/**
 * Tests for rem/scripts/scope-validate.mjs — memory scope integrity.
 * Run: node --test cc-market/rem/tests/scope-validate.test.mjs
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "scope-validate.mjs");
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "index-memory.js");

let root;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function project() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-val-"));
  fs.mkdirSync(path.join(root, ".git"));
  const day = path.join(root, ".claude", "memory", "2026", "06", "11");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "a.md"), "---\nname: a\ndescription: d\n---\n\nbody\n");
  return day;
}
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root },
});

describe("scope-validate", () => {
  test("a scope with a current derived index is clean", () => {
    project();
    run(INDEX);
    const r = run(SCRIPT, "--check");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /clean/);
  });

  test("a stale index warns and --fix regenerates it", () => {
    project();
    run(INDEX);
    fs.writeFileSync(path.join(root, ".claude", "memory", "2026", "06", "11", "b.md"), "---\nname: b\n---\n");
    assert.match(run(SCRIPT, "--check").stdout, /MEMORY\.md stale/);
    run(SCRIPT, "--fix");
    assert.match(run(SCRIPT, "--check").stdout, /clean/);
  });

  test("a leftover _meta.json is an error naming the migration", () => {
    const day = project();
    run(INDEX);
    fs.writeFileSync(path.join(day, "_meta.json"), "{}");
    const r = run(SCRIPT, "--check");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /leftover _meta\.json.*migrate\.mjs/);
  });

  test("an entry outside a dated directory warns", () => {
    project();
    run(INDEX);
    fs.writeFileSync(path.join(root, ".claude", "memory", "loose.md"), "---\nname: l\n---\n");
    assert.match(run(SCRIPT, "--check").stdout, /outside a dated directory: loose\.md/);
  });
});
