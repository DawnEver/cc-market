/**
 * Tests for rem/scripts/memo.js — fact memos with a git blob-hash invalidation key.
 * Run: node --test cc-market/rem/tests/memo.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { blobHash, drift, sourcesState, storeDir } from "../scripts/memo.js";

const PINS_JS = fileURLToPath(new URL("../scripts/memo.js", import.meta.url));

// ── Fixture: a temp git repo per test ────────────────────────────────────────

let repo;

function git(args, cwd = repo) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

function writeFile(rel, content, root = repo) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/** Run the CLI inside the fixture repo. Scope resolves from cwd, as it does
 *  for a real session (CLAUDE_PROJECT_DIR is that session's own root — a
 *  worktree gets its own, which the isolation test below depends on). */
function run(args, cwd = repo) {
  return spawnSync(process.execPath, [PINS_JS, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "rem-memo-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repo, ".claude", "memory"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── blobHash / drift (pure) ──────────────────────────────────────────────────

describe("blobHash", () => {
  test("hashes content; missing file is null", () => {
    const f = writeFile("a.txt", "hello\n");
    assert.match(blobHash(f), /^[0-9a-f]{40}$/);
    assert.equal(blobHash(path.join(repo, "nope.txt")), null);
  });

  test("content-identical after touch is unchanged; revert is unchanged", () => {
    const f = writeFile("a.txt", "hello\n");
    const was = blobHash(f);
    fs.utimesSync(f, new Date(), new Date());
    assert.equal(blobHash(f), was);
    fs.writeFileSync(f, "changed\n");
    assert.notEqual(blobHash(f), was);
    fs.writeFileSync(f, "hello\n");
    assert.equal(blobHash(f), was);
  });
});

describe("drift", () => {
  test("names exactly the sources whose hash moved", () => {
    const a = writeFile("a.txt", "a\n");
    const b = writeFile("b.txt", "b\n");
    const memo = { sources: sourcesState([a, b]) };
    assert.deepEqual(drift(memo), []);
    fs.writeFileSync(b, "b changed\n");
    assert.deepEqual(drift(memo), [b]);
  });
});

// ── CLI: save/get/list ────────────────────────────────────────────────────────

describe("cli", () => {
  test("save --file --lines slices a 1-indexed inclusive range; get answers FRESH", () => {
    writeFile("src.py", "l1\nl2\nl3\nl4\nl5\n");
    const saved = run(["save", "band", "--file", "src.py", "--lines", "2,4"]);
    assert.equal(saved.status, 0, saved.stderr);
    const get = run(["get", "band"]);
    assert.equal(get.status, 0, get.stderr);
    assert.equal(get.stdout, "l2\nl3\nl4");
    assert.match(get.stderr, /FRESH/);
  });

  test("editing the source makes get STALE (exit 2), naming the changed file", () => {
    writeFile("src.py", "l1\nl2\n");
    run(["save", "band", "--file", "src.py"]);
    fs.writeFileSync(path.join(repo, "src.py"), "l1\nCHANGED\n");
    const get = run(["get", "band"]);
    assert.equal(get.status, 2);
    assert.match(get.stderr, /STALE: src\.py/);
    assert.equal(get.stdout, "l1\nl2\n"); // the saved value, honestly labelled
  });

  test("--cmd without --from is refused; a failing command memos nothing", () => {
    const noFrom = run(["save", "probe", "--cmd", "echo hi"]);
    assert.equal(noFrom.status, 1);
    assert.match(noFrom.stderr, /--cmd needs --from/);

    writeFile("src.py", "x\n");
    const failing = run(["save", "probe", "--cmd", "exit 3", "--from", "src.py"]);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /nothing saved/);
    assert.ok(!fs.existsSync(path.join(repo, ".claude", "memo", "probe.json")));
  });

  test("--cmd memo captures stdout; get --refresh re-runs it when STALE", () => {
    writeFile("src.py", "v1\n");
    const saved = run(["save", "probe", "--cmd", "echo measured", "--from", "src.py"]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(run(["get", "probe"]).stdout.trim(), "measured");

    fs.writeFileSync(path.join(repo, "src.py"), "v2\n");
    const stale = run(["get", "probe"]);
    assert.equal(stale.status, 2);
    const refreshed = run(["get", "probe", "--refresh"]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.match(refreshed.stderr, /FRESH/);
  });

  test("list shows one line per memo with state; empty store says nothing saved", () => {
    assert.match(run(["list"]).stdout, /nothing saved/);
    writeFile("src.py", "l1\n");
    run(["save", "band", "--file", "src.py"]);
    const out = run(["list"]).stdout;
    assert.match(out, /band\s+FRESH/);
    fs.writeFileSync(path.join(repo, "src.py"), "moved\n");
    assert.match(run(["list"]).stdout, /band\s+STALE \(1 source\(s\) moved\)/);
  });

  test("get of an unknown memo exits 1", () => {
    const get = run(["get", "ghost"]);
    assert.equal(get.status, 1);
    assert.match(get.stderr, /no memo named 'ghost'/);
  });

  test("store lives under the scope's own .claude — a worktree does not see it", () => {
    writeFile("src.py", "l1\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    run(["save", "band", "--file", "src.py"]);

    const lane = path.join(os.tmpdir(), `rem-memo-lane-${process.pid}`);
    fs.rmSync(lane, { recursive: true, force: true });
    try {
      git(["worktree", "add", "-q", "--detach", lane]);
      fs.mkdirSync(path.join(lane, ".claude", "memory"), { recursive: true });
      assert.match(run(["list"], lane).stdout, /nothing saved/);
    } finally {
      git(["worktree", "remove", "--force", lane]);
    }
  });

  test("--hook mode swallows a broken store and still exits 0", () => {
    const dir = path.join(repo, ".claude", "memo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{not json", "utf8");
    const out = run(["list", "--hook"]);
    assert.equal(out.status, 0);
  });
});

describe("storeDir", () => {
  test("resolves under .claude/memo of the scope", () => {
    assert.equal(storeDir("/some/scope"), path.join("/some/scope", ".claude", "memo"));
  });
});
