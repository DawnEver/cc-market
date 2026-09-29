/**
 * Tests for rem/scripts/merge-memory.js — fold duplicates into one live entry, never delete.
 * Run: node --test cc-market/rem/tests/merge-memory.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "merge-memory.js");
const { addMergedFrom, mergeContent } = await import(new URL("../scripts/merge-memory.js", import.meta.url));

let tmp;
const day = () => path.join(tmp, ".claude", "memory", "2026", "07", "01");
const entry = (slug, body) => `---\nname: ${slug}\ndescription: about ${slug}\nmetadata:\n  type: project\n---\n\n${body}\n`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merge-memory-")));
  fs.mkdirSync(day(), { recursive: true });
  fs.writeFileSync(path.join(day(), "live.md"), entry("live", "Live finding: 1.25e-4 residual."));
  fs.writeFileSync(path.join(day(), "dup.md"), entry("dup", "Measured 7.8499932 vs 7.85.\n> \"quote kept\""));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("merge-memory.js", () => {
  test("folds the source verbatim, records merged_from, keeps the source file, tombstones its index row", () => {
    execFileSync(process.execPath, [SCRIPT, "--into", "2026/07/01/live.md", "--from", "2026/07/01/dup.md"], { cwd: tmp, encoding: "utf8" });
    const live = fs.readFileSync(path.join(day(), "live.md"), "utf8");
    assert.match(live, /merged_from:\n {2}- 2026\/07\/01\/dup\.md\n---/);
    assert.match(live, /Live finding: 1\.25e-4 residual\./);
    assert.match(live, /## Merged from 2026\/07\/01\/dup\.md/);
    assert.match(live, /Measured 7\.8499932 vs 7\.85\.\n> "quote kept"/);
    assert.equal(fs.readFileSync(path.join(day(), "dup.md"), "utf8"), entry("dup", "Measured 7.8499932 vs 7.85.\n> \"quote kept\""));
    const meta = JSON.parse(fs.readFileSync(path.join(day(), "_meta.json"), "utf8"));
    assert.equal(meta["dup.md"].dropped, "merged→2026/07/01/live.md");
  });

  test("merged_from extends an existing list without duplicating", () => {
    const once = addMergedFrom(entry("live", "x"), ["a.md"]);
    const twice = addMergedFrom(once, ["a.md", "b.md"]);
    assert.match(twice, /merged_from:\n {2}- a\.md\n {2}- b\.md\n---/);
  });

  test("a source may not be the live entry", () => {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--into", "2026/07/01/live.md", "--from", "2026/07/01/live.md"], { cwd: tmp, stdio: "pipe" }));
  });

  test("every source line survives the merge", () => {
    const out = mergeContent(entry("live", "a"), [{ path: "d.md", content: entry("d", "l1\n\nl2") }]);
    for (const l of ["a", "l1", "l2"]) assert.ok(out.includes(l));
  });
});
