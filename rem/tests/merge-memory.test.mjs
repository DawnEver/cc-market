/**
 * Tests for rem/scripts/merge-memory.js — fold duplicates into one NEW entry; the
 * sources stay byte-identical. (The CLI round trip is in provenance.test.mjs.)
 * Run: node --test cc-market/rem/tests/merge-memory.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "merge-memory.js");
const { mergeContent } = await import(new URL("../scripts/merge-memory.js", import.meta.url));

let tmp;
const day = () => path.join(tmp, ".claude", "memory", "2026", "07", "01");
const entry = (slug, body, type = "project") => `---\nname: ${slug}\ndescription: about ${slug}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: "utf8" });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merge-memory-")));
  fs.mkdirSync(path.join(tmp, ".git"));
  fs.mkdirSync(day(), { recursive: true });
  fs.writeFileSync(path.join(day(), "live.md"), entry("live", "Live finding: 1.25e-4 residual."));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("merge-memory.js", () => {
  test("every source line survives, under a heading naming its source", () => {
    const out = mergeContent("m", null, [
      { path: "2026/07/01/a.md", content: entry("a", "l1\n\nl2") },
      { path: "2026/07/01/b.md", content: entry("b", "l3") },
    ]);
    for (const l of ["l1", "l2", "l3", "## From 2026/07/01/a.md", "## From 2026/07/01/b.md"]) assert.ok(out.includes(l), l);
    assert.match(out, /^merged_from:\n {2}- 2026\/07\/01\/a\.md\n {2}- 2026\/07\/01\/b\.md$/m);
  });

  test("the merged entry keeps the kind its sources were", () => {
    const out = mergeContent("m", "d", [
      { path: "x.md", content: entry("x", "1", "feedback") },
      { path: "y.md", content: entry("y", "2", "feedback") },
      { path: "z.md", content: entry("z", "3", "project") },
    ]);
    assert.match(out, /^metadata:\n {2}type: feedback$/m);
  });

  test("a source must be an entry of the scope", () => {
    const r = run("--name", "m", "--from", "2026/07/01/nope.md");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an entry/);
  });

  test("an existing name is refused — an entry is never edited", () => {
    const today = new Date().toISOString().slice(0, 10).split("-");
    const target = path.join(tmp, ".claude", "memory", ...today, "m.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry("m", "already here"));
    const r = run("--name", "m", "--from", "2026/07/01/live.md");
    assert.equal(r.status, 1);
    assert.equal(fs.readFileSync(target, "utf8"), entry("m", "already here"));
  });

  test("--dry-run prints and writes nothing", () => {
    const before = fs.readdirSync(tmp, { recursive: true }).length;
    const r = run("--name", "m", "--from", "2026/07/01/live.md", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Live finding/);
    assert.equal(fs.readdirSync(tmp, { recursive: true }).length, before);
  });
});
