/**
 * Tests for rem/scripts/crystallize.js --drift — long-term drift-verification listing.
 * Run: node --test cc-market/rem/tests/crystallize.test.mjs
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
  "crystallize.js"
);

let tmp;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crystallize-")));
  fs.mkdirSync(path.join(tmp, ".claude", "memory", "2026", "07", "01"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function drift() {
  const out = execFileSync(process.execPath, [SCRIPT, "--drift"], {
    cwd: tmp,
    encoding: "utf8",
  });
  return JSON.parse(out).driftCandidates;
}

function seed(slug, meta) {
  const dir = path.join(tmp, ".claude", "memory", "2026", "07", "01");
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: x\nmetadata.type: project\n---\n\nbody\n`
  );
  const metaFile = path.join(dir, "_meta.json");
  const data = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  data[`${slug}.md`] = meta;
  fs.writeFileSync(metaFile, JSON.stringify(data));
}

describe("crystallize.js --drift", () => {
  test("lists only non-dropped long-term entries with path/name/dates/count", () => {
    seed("long-one", { accessed: "2026-07-20", count: 5, tier: "long" });
    seed("short-one", { accessed: "2026-07-21", count: 1, tier: "short" });
    seed("dropped-long", { accessed: "2026-07-22", count: 9, tier: "long", dropped: "crystallized" });

    const candidates = drift();
    assert.deepEqual(candidates, [
      {
        path: "2026/07/01/long-one.md",
        name: "long-one",
        created: "2026-07-01",
        accessed: "2026-07-20",
        count: 5,
      },
    ]);
  });

  test("empty when no long-term entries", () => {
    assert.deepEqual(drift(), []);
  });
});
