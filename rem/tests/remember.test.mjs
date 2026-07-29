/**
 * Tests for rem/scripts/remember.js — immediate-save CLI.
 * Run: node --test cc-market/rem/tests/remember.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "remember.js"
);

let tmp;
beforeEach(() => {
  // realpath: macOS /tmp is a symlink to /private/tmp; the script resolves paths.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remember-")));
  // A directory with .claude/memory/ qualifies as a scope.
  fs.mkdirSync(path.join(tmp, ".claude", "memory"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmp,
    encoding: "utf8",
  });
}

function runFail(...args) {
  try {
    run(...args);
    return null;
  } catch (e) {
    return e;
  }
}

function todayNested() {
  const d = new Date().toISOString().slice(0, 10);
  return d.replace(/-/g, "/");
}

function memoryFile(slug) {
  return path.join(tmp, ".claude", "memory", ...todayNested().split("/"), `${slug}.md`);
}

function metaFile() {
  return path.join(tmp, ".claude", "memory", ...todayNested().split("/"), "_meta.json");
}

const BASE = ["--name", "no-force-push", "--type", "feedback", "--body", "Never force-push shared branches."];

describe("remember.js", () => {
  test("creates memory file with frontmatter and prints its path", () => {
    const out = run(...BASE).trim();
    assert.equal(out, memoryFile("no-force-push"));
    const content = fs.readFileSync(out, "utf8");
    assert.match(content, /^---\nname: no-force-push\ndescription: Never force-push shared branches\.\nmetadata\.type: feedback\n---\n/);
    assert.match(content, /Never force-push shared branches\./);
  });

  test("creates _meta.json entry with short tier defaults", () => {
    run(...BASE);
    const meta = JSON.parse(fs.readFileSync(metaFile(), "utf8"));
    assert.deepEqual(meta["no-force-push.md"], {
      accessed: new Date().toISOString().slice(0, 10),
      count: 1,
      tier: "short",
    });
  });

  test("upserts MEMORY.md index entry", () => {
    run(...BASE);
    const index = fs.readFileSync(path.join(tmp, ".claude", "rules", "MEMORY.md"), "utf8");
    assert.match(index, new RegExp(`\\[\\d{4}-\\d{2}-\\d{2} no-force-push\\]\\(\\.\\./memory/${todayNested()}/no-force-push\\.md\\)`));
  });

  test("accepts body on stdin", () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, "--name", "stdin-body", "--type", "project"],
      { cwd: tmp, encoding: "utf8", input: "Body from stdin.\n" }
    ).trim();
    assert.match(fs.readFileSync(out, "utf8"), /Body from stdin\./);
  });

  test("derives description from first body line; --description overrides", () => {
    run("--name", "custom-desc", "--type", "reference", "--body", "Some body.", "--description", "Custom desc here");
    const content = fs.readFileSync(memoryFile("custom-desc"), "utf8");
    assert.match(content, /description: Custom desc here\n/);
  });

  test("rejects invalid name, type, and missing body", () => {
    assert.ok(runFail("--name", "Not_Kebab", "--type", "feedback", "--body", "x"));
    assert.ok(runFail("--name", "ok-name", "--type", "bogus", "--body", "x"));
    assert.ok(runFail("--name", "ok-name", "--type", "feedback"));
  });

  test("rejects volatile metadata fields in body", () => {
    const e = runFail("--name", "volatile", "--type", "user", "--body", "line\ntier: long");
    assert.match(e.stderr, /volatile metadata field/);
  });

  test("refuses to overwrite different content without --update", () => {
    run(...BASE);
    const e = runFail("--name", "no-force-push", "--type", "feedback", "--body", "Different body.");
    assert.match(e.stderr, /file exists with different content/);
  });

  test("identical re-run is idempotent", () => {
    run(...BASE);
    const out = run(...BASE).trim();
    assert.equal(out, memoryFile("no-force-push"));
    // Meta unchanged (still count 1)
    const meta = JSON.parse(fs.readFileSync(metaFile(), "utf8"));
    assert.equal(meta["no-force-push.md"].count, 1);
  });

  test("--update overwrites and preserves existing meta", () => {
    run(...BASE);
    run("--name", "no-force-push", "--type", "feedback", "--body", "Revised rule.", "--update");
    assert.match(fs.readFileSync(memoryFile("no-force-push"), "utf8"), /Revised rule\./);
    const meta = JSON.parse(fs.readFileSync(metaFile(), "utf8"));
    assert.equal(meta["no-force-push.md"].count, 1);
  });

  test("--scope <dir> writes into the given scope", () => {
    const other = path.join(tmp, "sub");
    fs.mkdirSync(path.join(other, ".claude", "memory"), { recursive: true });
    const out = run("--scope", other, ...BASE).trim();
    assert.ok(out.startsWith(other));
  });
});
