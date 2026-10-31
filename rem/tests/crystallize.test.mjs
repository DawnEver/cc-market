/**
 * Tests for rem/scripts/crystallize.js — distill entries into a rule; the entries stay on disk, hidden.
 * Run: node --test cc-market/rem/tests/crystallize.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "crystallize.js");

let tmp;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crystallize-")));
  fs.mkdirSync(path.join(tmp, ".git"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: tmp, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
});

function seed(rel, extra = "") {
  const file = path.join(tmp, ".claude", "memory", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const slug = path.basename(rel, ".md");
  fs.writeFileSync(file, `---\nname: ${slug}\ndescription: about ${slug}\n${extra}metadata:\n  type: project\n---\n\nbody SR-20260701-001\n`);
  return file;
}

function rule(name = "topic.md", text = "# Topic\n\n- the rule\n") {
  fs.mkdirSync(path.join(tmp, ".claude", "rules", "rem"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "rules", "rem", name), text);
}

describe("crystallize.js", () => {
  test("--propose lists visible entries oldest first and omits hidden ones", () => {
    seed("2026/07/01/a.md");
    seed("2026/07/02/b.md");
    seed("2026/07/03/c.md", "merged_from: 2026/07/02/b.md\n");
    const out = JSON.parse(run("--propose").stdout);
    assert.deepEqual(out.entries.map(e => e.path), ["2026/07/01/a.md", "2026/07/03/c.md"]);
  });

  test("--execute refuses without a written rule", () => {
    const a = seed("2026/07/01/a.md");
    const r = run("--execute", "--rule", "topic.md", "--distilled", "2026/07/01/a.md");
    assert.equal(r.status, 1);
    assert.ok(fs.existsSync(a));
  });

  test("--execute records a ledger entry naming the distilled entries, which stay on disk but hidden", () => {
    const a = seed("2026/07/01/a.md");
    const b = seed("2026/07/01/b.md");
    const keep = seed("2026/07/01/keep.md");
    rule();
    const r = run("--execute", "--rule", "topic.md", "--distilled", "2026/07/01/a.md,2026/07/01/b.md");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(keep));
    assert.deepEqual(JSON.parse(run("--propose").stdout).entries.map(e => e.path).filter(p => p.startsWith("2026/07/01/")).sort(), ["2026/07/01/keep.md"]);
    const ledger = fs.readdirSync(path.join(tmp, ".claude", "memory"), { recursive: true })
      .map(p => p.replace(/\\/g, "/")).find(p => p.endsWith("crystallized-into-topic.md"));
    const text = fs.readFileSync(path.join(tmp, ".claude", "memory", ledger), "utf8");
    assert.match(text, /merged_from:\n {2}- 2026\/07\/01\/a\.md\n {2}- 2026\/07\/01\/b\.md\n/);
    assert.match(text, /\.claude\/rules\/rem\/topic\.md/);
    assert.match(r.stdout, /SR-20260701-001/);
  });

  test("--execute refuses an entry that is not live", () => {
    rule();
    seed("2026/07/01/a.md");
    assert.equal(run("--execute", "--rule", "topic.md", "--distilled", "2026/07/01/nope.md").status, 1);
  });
});
