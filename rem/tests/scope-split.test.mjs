/**
 * Tests for scope-split — generic, structure-agnostic detection and execution of
 * memory scope splitting. Synthetic dir trees only (no dependency on this repo's layout).
 * Run: node --test cc-market/rem/tests/scope-split.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import {
  extractReferencedPaths,
  longestCommonDirPrefix,
  isInsideDir,
  inferEntrySubdir,
  clusterBySubdir,
  proposeScopeSplits,
  executeScopeSplit,
} from "../scripts/lib.mjs";

// ── helpers ─────────────────────────────────────────────────────────────────

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-split-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeMem(scopeRoot, relPath, { name, body = "", referenced = [] } = {}) {
  const abs = path.join(scopeRoot, ".claude", "memory", relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const refs = referenced.map((p) => `- \`${p}\``).join("\n");
  const slug = name || path.basename(relPath, ".md");
  fs.writeFileSync(
    abs,
    `---\nname: ${slug}\ndescription: test entry\nmetadata.type: project\n---\n\n${body}\n${refs}\n`,
    "utf8"
  );
}

function mkdir(scopeRoot, rel) {
  fs.mkdirSync(path.join(scopeRoot, rel), { recursive: true });
}

// ── extractReferencedPaths ────────────────────────────────────────────────────

describe("extractReferencedPaths", () => {
  test("pulls multi-segment path tokens from prose and backticks", () => {
    const paths = extractReferencedPaths(
      "Fixed `packages/api/server.js` and src/auth/login.ts in the handler."
    );
    assert.ok(paths.includes("packages/api/server.js"));
    assert.ok(paths.includes("src/auth/login.ts"));
  });

  test("ignores URLs", () => {
    const paths = extractReferencedPaths("see https://example.com/a/b/c for details");
    assert.ok(!paths.some((p) => p.includes("example.com")));
  });

  test("returns empty for path-free text", () => {
    assert.deepEqual(extractReferencedPaths("no paths here at all"), []);
  });
});

// ── longestCommonDirPrefix ────────────────────────────────────────────────────

describe("longestCommonDirPrefix", () => {
  test("returns shared directory prefix (drops file basenames)", () => {
    assert.equal(
      longestCommonDirPrefix(["pkg/rem/a.js", "pkg/rem/sub/b.js"]),
      "pkg/rem"
    );
  });

  test("empty when no shared prefix", () => {
    assert.equal(longestCommonDirPrefix(["a/x.js", "b/y.js"]), "");
  });

  test("empty for empty input", () => {
    assert.equal(longestCommonDirPrefix([]), "");
  });
});

// ── isInsideDir ───────────────────────────────────────────────────────────────

describe("isInsideDir", () => {
  test("true for descendant, false for traversal/sibling", () => {
    assert.equal(isInsideDir("/a/b", "/a/b/c/d.md"), true);
    assert.equal(isInsideDir("/a/b", "/a/b"), true);
    assert.equal(isInsideDir("/a/b", "/a/bb/c.md"), false);
    assert.equal(isInsideDir("/a/b", "/a/b/../x.md"), false);
  });
});

// ── inferEntrySubdir ──────────────────────────────────────────────────────────

describe("inferEntrySubdir", () => {
  test("maps entry to the deepest existing common subdir", () => {
    mkdir(tmp, "packages/api/src");
    const content = "touched `packages/api/src/server.js` and `packages/api/README.md`";
    assert.equal(inferEntrySubdir(tmp, content), "packages/api");
  });

  test("null when the inferred prefix does not exist on disk", () => {
    const content = "touched `ghost/module/x.js`";
    assert.equal(inferEntrySubdir(tmp, content), null);
  });

  test("null when references span unrelated modules (ambiguous owner)", () => {
    mkdir(tmp, "a");
    mkdir(tmp, "b");
    const content = "touched `a/x.js` and `b/y.js`";
    assert.equal(inferEntrySubdir(tmp, content), null);
  });

  test("null for entry with no referenced paths", () => {
    assert.equal(inferEntrySubdir(tmp, "a purely prose memory note"), null);
  });
});

// ── clusterBySubdir ───────────────────────────────────────────────────────────

describe("clusterBySubdir", () => {
  test("groups entry rel-paths by inferred subdir", () => {
    mkdir(tmp, "mod-a/src");
    mkdir(tmp, "mod-b");
    writeMem(tmp, "2026/06/01/e1.md", { referenced: ["mod-a/src/x.js"] });
    writeMem(tmp, "2026/06/02/e2.md", { referenced: ["mod-a/src/y.js"] });
    writeMem(tmp, "2026/06/03/e3.md", { referenced: ["mod-b/z.js"] });
    writeMem(tmp, "2026/06/04/e4.md", { referenced: [] });

    const clusters = clusterBySubdir(tmp, [
      "2026/06/01/e1.md",
      "2026/06/02/e2.md",
      "2026/06/03/e3.md",
      "2026/06/04/e4.md",
    ]);
    assert.deepEqual(clusters.get("mod-a/src"), ["2026/06/01/e1.md", "2026/06/02/e2.md"]);
    assert.deepEqual(clusters.get("mod-b"), ["2026/06/03/e3.md"]);
    assert.ok(!clusters.has(undefined)); // unassigned entries excluded
  });
});

// ── proposeScopeSplits ────────────────────────────────────────────────────────

describe("proposeScopeSplits", () => {
  test("silent when size pressure not met", () => {
    mkdir(tmp, "mod");
    for (let i = 0; i < 3; i++) writeMem(tmp, `2026/06/0${i + 1}/e${i}.md`, { referenced: ["mod/x.js"] });
    const out = proposeScopeSplits(tmp, { minOwnEntries: 30, minClusterEntries: 2, maxBytes: 1e9 });
    assert.deepEqual(out, []);
  });

  test("proposes a cluster that clears both bars and maps to a real subdir", () => {
    mkdir(tmp, "mod");
    for (let i = 0; i < 6; i++) writeMem(tmp, `2026/06/${String(i + 1).padStart(2, "0")}/e${i}.md`, { referenced: ["mod/x.js"] });
    const out = proposeScopeSplits(tmp, { minOwnEntries: 5, minClusterEntries: 5, maxBytes: 1e9 });
    assert.equal(out.length, 1);
    assert.equal(out[0].scope, "mod");
    assert.equal(out[0].entryCount, 6);
  });

  test("does not propose a subdir that is already its own scope", () => {
    mkdir(tmp, "mod/.claude/memory");
    for (let i = 0; i < 6; i++) writeMem(tmp, `2026/06/${String(i + 1).padStart(2, "0")}/e${i}.md`, { referenced: ["mod/x.js"] });
    const out = proposeScopeSplits(tmp, { minOwnEntries: 5, minClusterEntries: 5, maxBytes: 1e9 });
    assert.deepEqual(out, []);
  });

  test("skips clusters below the per-cluster minimum", () => {
    mkdir(tmp, "mod");
    for (let i = 0; i < 6; i++) writeMem(tmp, `2026/06/${String(i + 1).padStart(2, "0")}/e${i}.md`, { referenced: ["mod/x.js"] });
    const out = proposeScopeSplits(tmp, { minOwnEntries: 5, minClusterEntries: 10, maxBytes: 1e9 });
    assert.deepEqual(out, []);
  });
});

// ── executeScopeSplit ─────────────────────────────────────────────────────────
// A path is part of an entry's identity (citations name it), so a split moves NOTHING:
// it creates the child scope, NEW entries written there land in it, and recall from the
// child still finds the parent's entries.

describe("executeScopeSplit", () => {
  test("creates the child scope and leaves every existing entry where it is", () => {
    mkdir(tmp, "mod");
    writeMem(tmp, "2026/06/01/e1.md", { name: "e1", referenced: ["mod/x.js"] });
    const before = fs.readFileSync(path.join(tmp, ".claude/memory/2026/06/01/e1.md"), "utf8");
    const res = executeScopeSplit(tmp, "mod");
    assert.equal(res.scope, "mod");
    assert.equal(fs.readFileSync(path.join(tmp, ".claude/memory/2026/06/01/e1.md"), "utf8"), before);
    assert.ok(fs.existsSync(path.join(tmp, "mod/.claude/memory")));
    assert.ok(!fs.existsSync(path.join(tmp, "mod/.claude/memory/2026")));
    const parentIndex = fs.readFileSync(path.join(tmp, ".claude/memory-index.md"), "utf8");
    assert.ok(parentIndex.includes("2026/06/01/e1.md"));
    assert.ok(parentIndex.includes("mod → see mod/.claude/memory-index.md"));
  });

  test("recall from the child still finds the parent's entry about it", () => {
    mkdir(tmp, "mod");
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    writeMem(tmp, "2026/06/01/zebra-split.md", { name: "zebra-split", referenced: ["mod/x.js"] });
    executeScopeSplit(tmp, "mod");
    const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.js")],
      { input: JSON.stringify({ prompt: "zebra split", cwd: path.join(tmp, "mod") }), encoding: "utf8" });
    assert.match(r.stdout, /zebra-split/);
  });

  test("refuses a child path outside the scope", () => {
    assert.throws(() => executeScopeSplit(tmp, "../outside"));
  });
});

