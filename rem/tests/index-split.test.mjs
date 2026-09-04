/**
 * Tests for rebuildIndex()'s two-file output:
 *   - Injected view (.claude/rules/MEMORY.md): long-term entries + the newest
 *     HOT_SHORT_MAX short-term entries ONLY — bounded so the auto-loaded rules
 *     file stays small; dropped entries excluded.
 *   - Full catalog (.claude/meta/MEMORY.full.md, non-injected): EVERY non-dropped
 *     entry, newest-first — the authoritative listing crystallize/prune use.
 *
 * Run: node --test cc-market/rem/tests/index-split.test.mjs
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  rebuildIndex,
  catalogFilePath,
  saveMemoryMeta,
  HOT_SHORT_MAX,
} from "../scripts/lib.mjs";

const tmpRoots = [];

function tmpScope() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-index-split-"));
  fs.mkdirSync(path.join(root, ".claude", "memory"), { recursive: true });
  tmpRoots.push(root);
  return root;
}

function addShort(root, slug, datePath = "2026/09/01", { tier = "short" } = {}) {
  const dir = path.join(root, ".claude", "memory", datePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: test\nmetadata:\n  type: project\n---\n\nbody\n`,
    "utf8"
  );
  const metaFile = path.join(dir, "_meta.json");
  const meta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8"))
    : {};
  meta[`${slug}.md`] = { accessed: datePath.split("/").join("-"), count: 1, tier };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

function countEntries(file) {
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => /^-\s+\[/.test(l)).length;
}

function hasEntry(file, slug) {
  if (!fs.existsSync(file)) return false;
  return new RegExp(`\\]\\(\.\\./memory/[^)]*${slug}\\.md\\)`).test(
    fs.readFileSync(file, "utf8")
  );
}

afterEach(() => {
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("rebuildIndex hot injected view + full catalog", () => {
  test("injected file is bounded to longs + newest HOT_SHORT_MAX shorts", () => {
    const root = tmpScope();
    // 1 long + HOT_SHORT_MAX+3 shorts (all non-dropped). Inject more than the bound.
    addShort(root, "keep-long", "2026/08/01", { tier: "long" });
    for (let i = 0; i < HOT_SHORT_MAX + 3; i++) {
      addShort(root, `s-${String(i).padStart(3, "0")}`, "2026/09/01");
    }
    rebuildIndex(root);

    const injected = path.join(root, ".claude", "rules", "MEMORY.md");
    const catalog = catalogFilePath(root);

    assert.ok(fs.existsSync(injected), "injected .claude/rules/MEMORY.md exists");
    assert.ok(fs.existsSync(catalog), "full catalog file exists");
    assert.ok(!catalog.includes(`${path.sep}rules${path.sep}`), "catalog is not under rules/");

    // Injected = the long + only HOT_SHORT_MAX of the HOT_SHORT_MAX+3 shorts.
    assert.equal(countEntries(injected), 1 + HOT_SHORT_MAX);
    assert.ok(hasEntry(injected, "keep-long"), "long-term entry is in the injected view");
    // Full catalog holds every non-dropped entry.
    assert.equal(countEntries(catalog), 1 + HOT_SHORT_MAX + 3);
  });

  test("dropped entries are excluded from both the injected view and the catalog", () => {
    const root = tmpScope();
    addShort(root, "gone", "2026/09/01");
    saveMemoryMeta(root, "2026/09/01/gone.md", { dropped: "stale-90d" });
    addShort(root, "alive", "2026/09/01");
    rebuildIndex(root);

    const injected = path.join(root, ".claude", "rules", "MEMORY.md");
    const catalog = catalogFilePath(root);

    assert.ok(!hasEntry(injected, "gone"));
    assert.ok(!hasEntry(catalog, "gone"));
    assert.ok(hasEntry(injected, "alive"));
    assert.ok(hasEntry(catalog, "alive"));
  });

  test("injected header points at the full catalog; catalog is non-injected", () => {
    const root = tmpScope();
    addShort(root, "one", "2026/09/01");
    rebuildIndex(root);
    const injected = fs.readFileSync(
      path.join(root, ".claude", "rules", "MEMORY.md"),
      "utf8"
    );
    assert.match(injected, /Memory Index — hot set/);
    assert.match(injected, /MEMORY\.full\.md/); // tells the model where the full list is
  });
});
