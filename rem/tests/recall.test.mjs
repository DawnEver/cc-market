/**
 * Tests for rem/scripts/recall.js — prompt-time relevance recall.
 * Run: node --test cc-market/rem/tests/recall.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

import {
  tokenize,
  isSkippable,
  scopedContext,
  collectCandidates,
  readCandidates,
  requestBuild,
  buildIndex,
  indexFileFor,
  BUILD_LEASE_MS,
  buildInFlight,
  scopeFingerprint,
  scoreEntry,
  selectTop,
  buildRecallContext,
  appendTelemetry,
  finalizeTelemetry,
} from "../scripts/recall.js";

const RECALL_JS = fileURLToPath(new URL("../scripts/recall.js", import.meta.url));
// rem's one UserPromptSubmit hook: the process every prompt pays for.
const PROMPT_HOOK = fileURLToPath(new URL("../hooks/user-prompt.js", import.meta.url));

// ── tokenize ─────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  test("lowercases, splits on non-alphanumeric, drops stopwords and short tokens", () => {
    const toks = tokenize("Fix the WindowsHide bug in rem-hook.js, please!");
    assert.ok(toks.includes("windowshide"));
    assert.ok(toks.includes("bug"));
    assert.ok(toks.includes("rem"));
    assert.ok(toks.includes("hook"));
    assert.ok(!toks.includes("the"));
    assert.ok(!toks.includes("in"));
    assert.ok(!toks.includes("js")); // <3 chars
  });

  test("dedupes tokens", () => {
    assert.deepEqual(tokenize("bug bug BUG"), ["bug"]);
  });

  test("empty input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
  });

  test("CJK runs are segmented into bigrams", () => {
    const toks = tokenize("\u8BB0\u4F4F\u8FD9\u4E2A\u7EA6\u5B9A");
    assert.ok(toks.includes("\u8BB0\u4F4F"));
    assert.ok(toks.includes("\u7EA6\u5B9A"));
    assert.ok(toks.includes("\u4E2A\u7EA6"));
    assert.equal(toks.length, 5); // the five overlapping bigrams of the six-character run
  });

  test("mixed CJK + latin prompt keeps both", () => {
    const toks = tokenize("\u8BB0\u4F4F\u8FD9\u4E2A\uFF1A\u4E0D\u8981 force-push \u5171\u4EAB\u5206\u652F");
    assert.ok(toks.includes("force"));
    assert.ok(toks.includes("push")); // "push" from "force-push" split on '-'
    assert.ok(toks.includes("\u5171\u4EAB"));
    assert.ok(toks.includes("\u5206\u652F"));
  });

  test("single CJK char is kept as a token", () => {
    assert.deepEqual(tokenize("\u597D"), ["\u597D"]);
  });
});

// ── isSkippable ─────────────────────────────────────────────────────────────

describe("isSkippable", () => {
  test("skips tasks/ and manual.md", () => {
    assert.equal(isSkippable("tasks/open.md"), true);
    assert.equal(isSkippable("2026/06/27/manual.md"), true);
    assert.equal(isSkippable("2026/06/27/MANUAL.MD"), true);
    assert.equal(isSkippable("2026/06/20/persona-vs-output-style.md"), false);
  });
});

// ── scoreEntry ───────────────────────────────────────────────────────────────

describe("scoreEntry", () => {
  const now = Date.parse("2026-07-29T00:00:00Z");

  test("name match beats description match", () => {
    const nameHit = scoreEntry(
      { name: "windowshide-rule", description: "unrelated", type: "project", date: "2026-07-29" },
      ["windowshide"], now,
    );
    const descHit = scoreEntry(
      { name: "unrelated", description: "windowshide rule", type: "project", date: "2026-07-29" },
      ["windowshide"], now,
    );
    assert.ok(nameHit > descHit);
  });

  test("user/feedback type weighs double", () => {
    const base = { name: "git-conventions", description: "", date: "2026-07-29" };
    const user = scoreEntry({ ...base, type: "user" }, ["git"], now);
    const proj = scoreEntry({ ...base, type: "project" }, ["git"], now);
    assert.ok(Math.abs(user - 2 * proj) < 1e-9);
  });


  test("no token match scores zero", () => {
    assert.equal(scoreEntry(
      { name: "abc", description: "def", type: "project", date: "2026-07-29" },
      ["zzz"], now,
    ), 0);
  });

  test("empty tokens score zero", () => {
    assert.equal(scoreEntry({ name: "abc", description: "def", type: "user", date: "2026-07-29" }, [], now), 0);
  });
});

// ── scope fixtures ───────────────────────────────────────────────────────────

function mkMemory(scopeDir, datePath, slug, fm, body) {
  const dir = path.join(scopeDir, ".claude", "memory", ...datePath.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), `---\n${fm}---\n\n${body}\n`);
}

const FM = (name, desc, type) =>
  `name: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n`;

describe("recall over a fixture scope", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-"));
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("recall reads the root's memory only, from any cwd (a child scope is migrated, never read)", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    mkMemory(dir, "2026/07/01", "zebra-root", FM("zebra-root", "zebra notes", "project"), "root body");
    mkMemory(path.join(dir, "pkg"), "2026/07/01", "zebra-child", FM("zebra-child", "zebra notes", "project"), "child body");
    buildIndex(dir);
    const ctx = scopedContext("zebra notes", path.join(dir, "pkg"), Date.now(), { binding: () => null, refresh: () => {} }) || "";
    assert.match(ctx, /root body/, "PLANTED CONTROL: the root entry matches the same prompt");
    assert.doesNotMatch(ctx, /child body/);
  });

  test("collectCandidates reads frontmatter type and skips retired/tasks", () => {
    mkMemory(dir, "2026/07/01", "git-rules", FM("git-rules", "commit style", "feedback") + "merged_from: 2026/07/02/old-one.md\n",
      "Use conventional commits.");
    mkMemory(dir, "2026/07/02", "old-one", FM("old-one", "gone", "project"),
      "body");
    fs.mkdirSync(path.join(dir, ".claude", "memory", "tasks"), { recursive: true });

    const cands = collectCandidates(dir);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].name, "git-rules");
    assert.equal(cands[0].type, "feedback");
    assert.equal(cands[0].date, "2026-07-01");
  });

  test("selectTop picks the relevant entry above threshold", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit message style rules", "feedback"),
      "body");
    mkMemory(dir, "2026/07/01", "cooking-recipes", FM("cooking-recipes", "pasta and sauce", "reference"),
      "body");

    const winners = selectTop(collectCandidates(dir), tokenize("how should I write git commit messages"), Date.now());
    assert.equal(winners.length, 1);
    assert.equal(winners[0].name, "git-conventions");
  });

  test("selectTop caps at 3 and returns [] when nothing matches", () => {
    for (let i = 0; i < 5; i++) {
      mkMemory(dir, "2026/07/0" + (i + 1), `git-topic-${i}`, FM(`git-topic-${i}`, "git stuff", "project"),
        "body");
    }
    const winners = selectTop(collectCandidates(dir), ["git"], Date.now());
    assert.equal(winners.length, 3);
    assert.deepEqual(selectTop(collectCandidates(dir), ["nonexistenttoken"], Date.now()), []);
  });

  test("buildRecallContext emits header and bodies, capped at maxBytes", () => {
    mkMemory(dir, "2026/07/01", "big-entry", FM("big-entry", "big", "project"),
      "x".repeat(3000));
    mkMemory(dir, "2026/07/02", "small-entry", FM("small-entry", "small", "project"),
      "short body");

    const cands = collectCandidates(dir);
    const ctx = buildRecallContext(cands, 1024);
    assert.match(ctx, /^Relevant memories \(auto-recalled\):/);
    assert.ok(ctx.length <= 1024);
    assert.equal(buildRecallContext([], 1024), null);
  });
});

// ── candidate cache ──────────────────────────────────────────────────────────

describe("the candidate index: the hook reads, the build writes", () => {
  let dir;
  const T0 = Date.parse("2026-07-31T00:00:00Z"); // fixed clock for TTL tests
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-cache-")));
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a built index is read back identically, fresh within the TTL", () => {
    mkMemory(dir, "2026/07/01", "git-rules", FM("git-rules", "commit style", "feedback"),
      "body");
    const built = collectCandidates(dir, { now: T0 });
    const info = {};
    const read = readCandidates(dir, { now: T0 + 1000, info });
    assert.deepEqual(read.candidates, built);
    assert.equal(read.stale, false);
    assert.equal(info.cacheHit, true);
    assert.equal(info.fast, true);
  });

  test("no index reads as stale and empty", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"), "body");
    assert.deepEqual(readCandidates(dir, { now: T0 }), { candidates: [], stale: true });
  });

  test("a half-written or foreign index reads as stale and empty, never throws", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"), "body");
    collectCandidates(dir, { now: T0 });
    assert.equal(readCandidates(dir, { now: T0 + 1000 }).candidates.length, 1, "PLANTED CONTROL: the whole index reads");
    const file = indexFileFor(dir);
    const whole = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
      assert.deepEqual(readCandidates(dir, { now: T0 + 1000 }), { candidates: [], stale: true });
      fs.writeFileSync(file, JSON.stringify({ something: "else" }));
      assert.deepEqual(readCandidates(dir, { now: T0 + 1000 }), { candidates: [], stale: true });
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.ts`, { force: true });
    }
  });

  test("past the TTL the old index is served and called stale; the build picks the write up", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body");
    const fp1 = scopeFingerprint(dir);
    collectCandidates(dir, { now: T0 });
    mkMemory(dir, "2026/07/02", "two", FM("two", "second", "project"),
      "body");
    assert.notEqual(fp1, scopeFingerprint(dir));
    const withinTtl = readCandidates(dir, { now: T0 + 1000 });
    assert.equal(withinTtl.candidates.length, 1, "within the TTL the tree is not re-walked");
    assert.equal(withinTtl.stale, false);
    const afterTtl = readCandidates(dir, { now: T0 + 60_000 });
    assert.equal(afterTtl.candidates.length, 1, "the hook never reads the new entry itself");
    assert.equal(afterTtl.stale, true);
    const rebuilt = collectCandidates(dir, { now: T0 + 60_000 });
    assert.deepEqual(rebuilt.map((c) => c.name).sort(), ["one", "two"]);
  });

  test("a superseding entry retires the old one on the next build", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body");
    assert.equal(collectCandidates(dir, { now: T0 }).length, 1);
    mkMemory(dir, "2026/07/02", "one", FM("one", "first", "project") + "merged_from: 2026/07/01/one.md\n", "body");
    assert.deepEqual(collectCandidates(dir, { now: T0 + 60_000 }).map((c) => c.relPath), ["2026/07/02/one.md"]);
  });

  test("a rebuild over an unchanged tree re-reads no file", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body");
    const first = collectCandidates(dir, { now: T0 });
    const info = {};
    const second = collectCandidates(dir, { now: T0 + 60_000, info });
    assert.deepEqual(second, first);
    assert.equal(info.cacheHit, true);
    assert.equal(info.read, 0);
  });

  test("useCache:false bypasses the index", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body");
    const cands = collectCandidates(dir, { useCache: false });
    assert.equal(cands.length, 1);
  });
});

// ── the background build ─────────────────────────────────────────────────────

describe("requestBuild: one detached build at a time", () => {
  let dir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-lease-")));
  });
  afterEach(() => {
    fs.rmSync(`${indexFileFor(dir)}.build`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the first request starts the build, a second while it runs does not", () => {
    const started = [];
    const start = (root) => started.push(root);
    assert.equal(requestBuild(dir, { start }), true, "PLANTED CONTROL: a free lease starts a build");
    assert.equal(requestBuild(dir, { start }), false);
    assert.deepEqual(started, [dir]);
  });

  test("a lease older than BUILD_LEASE_MS belongs to a dead build and is taken over", () => {
    const started = [];
    const start = (root) => started.push(root);
    requestBuild(dir, { start });
    const old = new Date(Date.now() - BUILD_LEASE_MS - 1000);
    fs.utimesSync(`${indexFileFor(dir)}.build`, old, old);
    assert.equal(requestBuild(dir, { start }), true);
    assert.equal(started.length, 2);
  });

  test("the build releases its lease, so the next stale prompt can start another", () => {
    const start = () => {};
    requestBuild(dir, { start });
    assert.equal(buildInFlight(dir), true, "PLANTED CONTROL: a started build holds the lease");
    buildIndex(dir);
    assert.equal(buildInFlight(dir), false);
    assert.equal(requestBuild(dir, { start }), true);
  });

  test("several sessions at once: of many concurrent requests exactly one starts a build", async () => {
    const marks = path.join(dir, "starts");
    const code = `import("${pathToFileURL(RECALL_JS).href}").then((m) => { if (m.requestBuild(process.argv[1], { start: () => {} })) require("node:fs").appendFileSync(process.argv[2], "x"); })`;
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
      spawn(process.execPath, ["-e", code, dir, marks], { windowsHide: true, stdio: "ignore" }).on("exit", resolve);
    })));
    assert.equal(fs.readFileSync(marks, "utf8"), "x");
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

describe("recall.js CLI", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-cli-"));
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(payload, env = {}) {
    return spawnSync(process.execPath, [PROMPT_HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...env },
      windowsHide: true,
    });
  }
  // The index a background build leaves: the hook itself only reads it.
  const build = (root) => assert.equal(spawnSync(process.execPath, [RECALL_JS, "--build", root], { windowsHide: true }).status, 0);

  test("emits additionalContext for a matching prompt", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit message style rules", "feedback"),
      "Use conventional commits with double quotes.");
    build(dir);

    const r = run({ prompt: "how do I write git commit messages?", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /auto-recalled/);
    assert.match(out.hookSpecificOutput.additionalContext, /conventional commits/);
  });

  test("emits additionalContext for a fully Chinese prompt (CJK recall)", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "\u63D0\u4EA4\u4FE1\u606F\u98CE\u683C\u7EA6\u5B9A", "feedback"),
      "\u4F7F\u7528\u7EA6\u5B9A\u5F0F\u63D0\u4EA4\u3002");
    build(dir);
    const r = run({ prompt: "\u63D0\u4EA4\u4FE1\u606F\u5E94\u8BE5\u600E\u4E48\u5199\uFF1F", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /auto-recalled/);
  });

  test("silent when nothing matches", () => {
    build(dir);
    const r = run({ prompt: "zzz qqq nonexistent", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  test("Codex UserPromptSubmit recalls the same scoped memories", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit style", "feedback"),
      "body");
    build(dir);
    const r = run(
      { prompt: "git commit style", cwd: dir },
      { CLAUDE_PLUGIN_ROOT: "/home/u/.codex/plugins/cache/cc-market/rem/1.0.0" },
    );
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Relevant memories/);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.claude', 'memory', '2026', '07', '01')), ['git-conventions.md'],
      'recall writes nothing beside the entry it read');
  });

  test("exits 0 on malformed stdin (never breaks the session)", () => {
    const r = spawnSync(process.execPath, [PROMPT_HOOK], {
      input: "not json {",
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  test("runs well under the latency budget", () => {
    for (let i = 0; i < 30; i++) {
      mkMemory(dir, "2026/07/01", `entry-${i}`, FM(`entry-${i}`, `memory about topic${i} git`, "project"),
        "body ".repeat(50));
    }
    build(dir);
    // Relative to a bare node start measured just before: a loaded machine (a parallel suite, a
    // release run) slows both alike, so the bound tests recall's own work, not the host's load.
    const b0 = Date.now();
    spawnSync(process.execPath, ["-e", "0"], { windowsHide: true });
    const baseline = Date.now() - b0;
    const t0 = Date.now();
    const r = run({ prompt: "tell me about git", cwd: dir, session_id: "s1" });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.ok(elapsed < 3 * baseline + 1000, `took ${elapsed}ms against a ${baseline}ms bare node start`);
  });

  test("cold over a planted large memory set: answers in budget, the detached build lands, the next prompt recalls", async () => {
    for (let d = 1; d <= 20; d++) {
      for (let i = 0; i < 100; i++) {
        mkMemory(dir, `2026/07/${String(d).padStart(2, "0")}`, `n${d}-${i}`, FM(`note-${d}-${i}`, `filler${i} detail`, "project"), "body");
      }
    }
    mkMemory(dir, "2026/07/07", "zebra-budget", FM("zebra-budget", "zebra budget notes", "project"), "the zebra budget body");
    const b0 = Date.now();
    spawnSync(process.execPath, ["-e", "0"], { windowsHide: true });
    const baseline = Date.now() - b0;
    const t0 = Date.now();
    const cold = run({ prompt: "zebra budget", cwd: dir, session_id: "s1" });
    const elapsed = Date.now() - t0;
    assert.equal(cold.status, 0);
    assert.equal(cold.stdout.trim(), "", "no index yet: the cold prompt answers with what it has");
    assert.ok(elapsed < 3 * baseline + 1000 && elapsed < 5000, `cold took ${elapsed}ms against a ${baseline}ms bare node start`);
    // The detached build outlives the hook: wait for its lease to drop and its index to land.
    const index = indexFileFor(dir);
    for (const until = Date.now() + 180_000; Date.now() < until && (buildInFlight(dir) || !fs.existsSync(index));) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(fs.existsSync(index), "PLANTED CONTROL: the cold prompt started a build that wrote the index");
    const warm = run({ prompt: "zebra budget", cwd: dir, session_id: "s2" });
    assert.match(JSON.parse(warm.stdout).hookSpecificOutput.additionalContext, /the zebra budget body/);
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.ts`, { force: true });
    fs.rmSync(`${index}.build`, { force: true });
  });
});

// ── the per-prompt budget ────────────────────────────────────────────────────
// Every prompt waits for recall (it was p95 10.5 s, a third killed at the 15 s timeout; 110 s on a
// cold 6k-entry machine, 2026-11-17). It reads a ready index and never builds one in-line; the build
// is a detached background job. These hold that, each beside its plant.

describe("the per-prompt budget", () => {
  const session = () => `budget-${crypto.randomUUID()}`;
  const counter = (answer) => { const read = () => { read.calls++; return answer; }; read.calls = 0; return read; };

  test("the fingerprint stats directories, never the 6000 entry files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-budget-"));
    for (let d = 1; d <= 60; d++) {
      const day = path.join(root, ".claude", "memory", "2026", "07", String(d).padStart(2, "0"));
      fs.mkdirSync(day, { recursive: true });
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(day, `e${i}.md`), "---\nname: e\n---\n");
    }
    const stat = fs.statSync;
    let calls = 0;
    fs.statSync = (...a) => { calls++; return stat(...a); };
    try { scopeFingerprint(root); } finally { fs.statSync = stat; }
    assert.ok(calls > 0, "PLANTED CONTROL: the spy sees the walk");
    assert.ok(calls <= 70, `${calls} stats for 60 directories and 6000 files`);
  });

  test("a new entry re-reads only its own directory, never the whole tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-budget-"));
    const day = (d) => path.join(root, ".claude", "memory", "2026", "07", String(d).padStart(2, "0"));
    for (let d = 1; d <= 20; d++) {
      fs.mkdirSync(day(d), { recursive: true });
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(day(d), `e${i}.md`), `---\nname: e${d}-${i}\n---\n`);
    }
    const T0 = Date.now() + 86_400_000; // past any stamp an earlier run left
    const cold = {};
    collectCandidates(root, { now: T0, info: cold });
    assert.equal(cold.read, 1000, "PLANTED CONTROL: the first build reads every file");
    fs.writeFileSync(path.join(day(7), "fresh.md"), "---\nname: fresh\n---\n");
    const warm = {};
    const cands = collectCandidates(root, { now: T0 + 60_000, info: warm });
    assert.equal(warm.read, 51, "one directory moved, so only its 51 files are read");
    assert.ok(cands.some((c) => c.name === "fresh"));
    assert.equal(cands.length, 1001);
  });

  test("a warm prompt over 6000 entries stays inside the budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-budget-"));
    fs.mkdirSync(path.join(root, ".git"));
    for (let d = 1; d <= 60; d++) {
      const day = path.join(root, ".claude", "memory", "2026", "07", String(d).padStart(2, "0"));
      fs.mkdirSync(day, { recursive: true });
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(day, `n${d}-${i}.md`), `---\nname: note-${d}-${i}\ndescription: topic${i} detail\n---\n\nbody\n`);
      }
    }
    const read = counter(null);
    const refresh = counter(true);
    const s = session();
    buildIndex(root); // the background build, done earlier
    const t0 = Date.now();
    // An hour later: the TTL has lapsed -- the common case. The old index is served at once and
    // the refresh is handed to the background.
    const ctx = scopedContext("topic7 detail", root, Date.now() + 3_600_000, { session: s, binding: read, refresh });
    const elapsed = Date.now() - t0;
    assert.match(ctx || "", /Relevant memories/);
    assert.equal(read.calls, 1, "one ledger read per prompt");
    assert.equal(refresh.calls, 1, "a stale index asks for one background build");
    assert.ok(elapsed < 1000, `a warm prompt took ${elapsed}ms (budget 1000ms in-process; hook p95 target < 2 s)`);
  });

  test("cold: with no index the hook reads no memory file, asks for the build, and answers in budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rem-budget-"));
    fs.mkdirSync(path.join(root, ".git"));
    for (let d = 1; d <= 30; d++) {
      const day = path.join(root, ".claude", "memory", "2026", "07", String(d).padStart(2, "0"));
      fs.mkdirSync(day, { recursive: true });
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(day, `n${d}-${i}.md`), `---\nname: note-${d}-${i}\ndescription: topic${i} detail\n---\n\nbody\n`);
      }
    }
    // A spy on the builtin fs, synced into every module's named imports.
    const original = fs.readFileSync;
    let memoryReads = 0;
    fs.readFileSync = (file, ...rest) => {
      if (/[\\/]\.claude[\\/]memory[\\/].*\.md$/.test(String(file))) memoryReads++;
      return original(file, ...rest);
    };
    syncBuiltinESMExports();
    const refresh = counter(true);
    try {
      const t0 = Date.now();
      const ctx = scopedContext("topic7 detail", root, Date.now(), { session: session(), binding: counter(null), refresh });
      const elapsed = Date.now() - t0;
      assert.equal(ctx, null, "no index yet: nothing to recall");
      assert.equal(memoryReads, 0, "the hook never reads a memory file to build an index");
      assert.equal(refresh.calls, 1, "it asks for one background build instead");
      assert.ok(elapsed < 1000, `a cold prompt took ${elapsed}ms`);
      buildIndex(root);
      assert.equal(memoryReads, 3000, "PLANTED CONTROL: the spy sees the build read every entry");
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
    const fresh = counter(true);
    assert.match(scopedContext("topic7 detail", root, Date.now(), { session: session(), binding: counter(null), refresh: fresh }) || "", /Relevant memories/,
      "the built index answers the next prompt");
    assert.equal(fresh.calls, 0, "a fresh index asks for nothing");
  });

});

// ── telemetry ────────────────────────────────────────────────────────────────

describe("telemetry", () => {
  let dir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-tele-")));
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ringFile(scopeDir) {
    const key = crypto.createHash("sha1").update(path.resolve(scopeDir)).digest("hex").slice(0, 16);
    return path.join(os.tmpdir(), `rem-recall-telemetry-${key}.json`);
  }
  function readRing(scopeDir) {
    return JSON.parse(fs.readFileSync(ringFile(scopeDir), "utf8"));
  }

  test("finalizeTelemetry replaces the newest pending row", () => {
    appendTelemetry(dir, { t: "2026-07-31T00:00:00Z", done: false });
    appendTelemetry(dir, { t: "2026-07-31T00:00:01Z", done: false });
    finalizeTelemetry(dir, { t: "2026-07-31T00:00:02Z", done: true, ms: 42 });
    const ring = readRing(dir);
    assert.equal(ring.length, 2);
    assert.equal(ring[0].done, false); // older pending row untouched
    assert.equal(ring[1].ms, 42);
    fs.rmSync(ringFile(dir), { force: true });
  });

  test("ring is trimmed to 20 entries", () => {
    for (let i = 0; i < 25; i++) appendTelemetry(dir, { t: `t${i}`, done: true, ms: i });
    assert.equal(readRing(dir).length, 20);
    fs.rmSync(ringFile(dir), { force: true });
  });

  test("a CLI run leaves a completed telemetry row; --telemetry prints it", () => {
    mkMemory(dir, "2026/07/01", "git-rules", FM("git-rules", "commit style", "feedback"),
      "body");
    assert.equal(spawnSync(process.execPath, [RECALL_JS, "--build", dir], { windowsHide: true }).status, 0);
    const r = spawnSync(process.execPath, [PROMPT_HOOK], {
      input: JSON.stringify({ prompt: "git commit style", cwd: dir }),
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const ring = readRing(dir);
    assert.equal(ring.length, 1);
    assert.equal(ring[0].done, true);
    assert.ok(Number.isFinite(ring[0].ms));
    assert.equal(typeof ring[0].cache, "boolean");
    assert.equal(typeof ring[0].fast, "boolean");

    const t = spawnSync(process.execPath, [RECALL_JS, "--telemetry"], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    });
    assert.equal(t.status, 0);
    assert.match(t.stdout, /completed/);
    fs.rmSync(ringFile(dir), { force: true });
  });
});
