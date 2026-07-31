/**
 * Tests for rem/scripts/recall.js — prompt-time relevance recall.
 * Run: node --test cc-market/rem/tests/recall.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import {
  tokenize,
  findScopeForCwd,
  isSkippable,
  collectCandidates,
  scopeFingerprint,
  scoreEntry,
  selectTop,
  buildRecallContext,
  appendTelemetry,
  finalizeTelemetry,
} from "../scripts/recall.js";

const RECALL_JS = fileURLToPath(new URL("../scripts/recall.js", import.meta.url));

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
    const toks = tokenize("记住这个约定");
    assert.ok(toks.includes("记住"));
    assert.ok(toks.includes("约定"));
    assert.ok(toks.includes("个约"));
    assert.equal(toks.length, 5); // 记住 住这 这个 个约 约定
  });

  test("mixed CJK + latin prompt keeps both", () => {
    const toks = tokenize("记住这个：不要 force-push 共享分支");
    assert.ok(toks.includes("force"));
    assert.ok(toks.includes("push")); // "push" from "force-push" split on '-'
    assert.ok(toks.includes("共享"));
    assert.ok(toks.includes("分支"));
  });

  test("single CJK char is kept as a token", () => {
    assert.deepEqual(tokenize("好"), ["好"]);
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
      { name: "windowshide-rule", description: "unrelated", type: "project", accessed: "2026-07-29", count: 1 },
      ["windowshide"], now,
    );
    const descHit = scoreEntry(
      { name: "unrelated", description: "windowshide rule", type: "project", accessed: "2026-07-29", count: 1 },
      ["windowshide"], now,
    );
    assert.ok(nameHit > descHit);
  });

  test("user/feedback type weighs double", () => {
    const base = { name: "git-conventions", description: "", accessed: "2026-07-29", count: 1 };
    const user = scoreEntry({ ...base, type: "user" }, ["git"], now);
    const proj = scoreEntry({ ...base, type: "project" }, ["git"], now);
    assert.ok(Math.abs(user - 2 * proj) < 1e-9);
  });

  test("access count boosts up to cap", () => {
    const base = { name: "git-conventions", description: "", type: "project", accessed: "2026-07-29" };
    const low = scoreEntry({ ...base, count: 1 }, ["git"], now);
    const high = scoreEntry({ ...base, count: 5 }, ["git"], now);
    const over = scoreEntry({ ...base, count: 100 }, ["git"], now);
    assert.ok(high > low);
    assert.equal(over, high); // capped at 5
  });

  test("no token match scores zero", () => {
    assert.equal(scoreEntry(
      { name: "abc", description: "def", type: "project", accessed: "2026-07-29", count: 1 },
      ["zzz"], now,
    ), 0);
  });

  test("empty tokens score zero", () => {
    assert.equal(scoreEntry({ name: "abc", description: "def", type: "user", accessed: "2026-07-29", count: 1 }, [], now), 0);
  });
});

// ── scope fixtures ───────────────────────────────────────────────────────────

function mkMemory(scopeDir, datePath, slug, fm, body, meta) {
  const dir = path.join(scopeDir, ".claude", "memory", ...datePath.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), `---\n${fm}---\n\n${body}\n`);
  const metaFile = path.join(dir, "_meta.json");
  const data = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  data[`${slug}.md`] = meta;
  fs.writeFileSync(metaFile, JSON.stringify(data));
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

  test("findScopeForCwd walks up from a nested cwd", () => {
    const deep = path.join(dir, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(findScopeForCwd(deep), dir);
    assert.equal(findScopeForCwd(path.join(os.tmpdir(), "no-scope-here-" + Date.now())), null);
  });

  test("collectCandidates reads frontmatter type and skips dropped/tasks", () => {
    mkMemory(dir, "2026/07/01", "git-rules", FM("git-rules", "commit style", "feedback"),
      "Use conventional commits.", { accessed: "2026-07-20", count: 4, tier: "short" });
    mkMemory(dir, "2026/07/02", "dropped-one", FM("dropped-one", "gone", "project"),
      "body", { accessed: "2026-07-02", count: 1, tier: "short", dropped: "evicted" });
    fs.mkdirSync(path.join(dir, ".claude", "memory", "tasks"), { recursive: true });

    const cands = collectCandidates(dir);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].name, "git-rules");
    assert.equal(cands[0].type, "feedback");
    assert.equal(cands[0].count, 4);
  });

  test("selectTop picks the relevant entry above threshold", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit message style rules", "feedback"),
      "body", { accessed: "2026-07-20", count: 3, tier: "short" });
    mkMemory(dir, "2026/07/01", "cooking-recipes", FM("cooking-recipes", "pasta and sauce", "reference"),
      "body", { accessed: "2026-07-01", count: 1, tier: "short" });

    const winners = selectTop(collectCandidates(dir), tokenize("how should I write git commit messages"), Date.now());
    assert.equal(winners.length, 1);
    assert.equal(winners[0].name, "git-conventions");
  });

  test("selectTop caps at 3 and returns [] when nothing matches", () => {
    for (let i = 0; i < 5; i++) {
      mkMemory(dir, "2026/07/0" + (i + 1), `git-topic-${i}`, FM(`git-topic-${i}`, "git stuff", "project"),
        "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    }
    const winners = selectTop(collectCandidates(dir), ["git"], Date.now());
    assert.equal(winners.length, 3);
    assert.deepEqual(selectTop(collectCandidates(dir), ["nonexistenttoken"], Date.now()), []);
  });

  test("buildRecallContext emits header and bodies, capped at maxBytes", () => {
    mkMemory(dir, "2026/07/01", "big-entry", FM("big-entry", "big", "project"),
      "x".repeat(3000), { accessed: "2026-07-20", count: 1, tier: "short" });
    mkMemory(dir, "2026/07/02", "small-entry", FM("small-entry", "small", "project"),
      "short body", { accessed: "2026-07-21", count: 1, tier: "short" });

    const cands = collectCandidates(dir);
    const ctx = buildRecallContext(cands, 1024);
    assert.match(ctx, /^Relevant memories \(auto-recalled\):/);
    assert.ok(ctx.length <= 1024);
    assert.equal(buildRecallContext([], 1024), null);
  });
});

// ── candidate cache ──────────────────────────────────────────────────────────

describe("collectCandidates cache", () => {
  let dir;
  const T0 = Date.parse("2026-07-31T00:00:00Z"); // fixed clock for TTL tests
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rem-recall-cache-")));
    fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cache hit returns identical candidates without re-reading", () => {
    mkMemory(dir, "2026/07/01", "git-rules", FM("git-rules", "commit style", "feedback"),
      "body", { accessed: "2026-07-20", count: 2, tier: "short" });
    const first = collectCandidates(dir, { now: T0 });
    const info = {};
    const second = collectCandidates(dir, { now: T0 + 1000, info }); // within TTL → fast path
    assert.deepEqual(second, first);
    assert.equal(second[0].name, "git-rules");
    assert.equal(info.cacheHit, true);
    assert.equal(info.fast, true);
  });

  test("fingerprint changes when a memory file is added → cache invalidated after TTL", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    const fp1 = scopeFingerprint(dir);
    collectCandidates(dir, { now: T0 }); // populate cache
    mkMemory(dir, "2026/07/02", "two", FM("two", "second", "project"),
      "body", { accessed: "2026-07-21", count: 1, tier: "short" });
    const fp2 = scopeFingerprint(dir);
    assert.notEqual(fp1, fp2);
    const cands = collectCandidates(dir, { now: T0 + 60_000 }); // TTL expired → re-stat picks it up
    assert.deepEqual(cands.map((c) => c.name).sort(), ["one", "two"]);
  });

  test("fingerprint changes when _meta.json changes (drop → invalidated after TTL)", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    assert.equal(collectCandidates(dir, { now: T0 }).length, 1);
    // Drop the entry by rewriting _meta.json.
    const metaFile = path.join(dir, ".claude", "memory", "2026", "07", "01", "_meta.json");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta["one.md"].dropped = "evicted";
    fs.writeFileSync(metaFile, JSON.stringify(meta) + " "); // size must change
    assert.equal(collectCandidates(dir, { now: T0 + 60_000 }).length, 0);
  });

  test("within TTL the cache is served without re-stating the tree (bounded staleness)", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    assert.equal(collectCandidates(dir, { now: T0 }).length, 1);
    // A memory write lands within the TTL window.
    mkMemory(dir, "2026/07/02", "two", FM("two", "second", "project"),
      "body", { accessed: "2026-07-21", count: 1, tier: "short" });
    const info = {};
    const withinTtl = collectCandidates(dir, { now: T0 + 1000, info });
    assert.equal(withinTtl.length, 1); // stale — the tree was not re-walked
    assert.equal(info.cacheHit, true);
    assert.equal(info.fast, true);
    // After the TTL expires the tree is re-statted and the write is picked up.
    const info2 = {};
    const afterTtl = collectCandidates(dir, { now: T0 + 60_000, info: info2 });
    assert.equal(afterTtl.length, 2);
    assert.equal(info2.cacheHit, false);
    assert.equal(info2.fast, false);
  });

  test("TTL expiry with unchanged tree reuses candidates (fingerprint still guards correctness)", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    const first = collectCandidates(dir, { now: T0 });
    const info = {};
    const second = collectCandidates(dir, { now: T0 + 60_000, info });
    assert.deepEqual(second, first);   // same candidates, no frontmatter re-read
    assert.equal(info.cacheHit, true); // fingerprint matched → reused
    assert.equal(info.fast, false);    // but the tree was re-statted
  });

  test("useCache:false bypasses the cache", () => {
    mkMemory(dir, "2026/07/01", "one", FM("one", "first", "project"),
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    const cands = collectCandidates(dir, { useCache: false });
    assert.equal(cands.length, 1);
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
    return spawnSync(process.execPath, [RECALL_JS], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...env },
      windowsHide: true,
    });
  }

  test("emits additionalContext for a matching prompt", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit message style rules", "feedback"),
      "Use conventional commits with double quotes.", { accessed: "2026-07-20", count: 3, tier: "short" });

    const r = run({ prompt: "how do I write git commit messages?", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /auto-recalled/);
    assert.match(out.hookSpecificOutput.additionalContext, /conventional commits/);
  });

  test("emits additionalContext for a fully Chinese prompt (CJK recall)", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "提交信息风格约定", "feedback"),
      "使用约定式提交。", { accessed: "2026-07-20", count: 3, tier: "short" });
    const r = run({ prompt: "提交信息应该怎么写？", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /auto-recalled/);
  });

  test("silent when nothing matches", () => {
    const r = run({ prompt: "zzz qqq nonexistent", cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  test("silent on Codex host (no UserPromptSubmit equivalent)", () => {
    mkMemory(dir, "2026/07/01", "git-conventions", FM("git-conventions", "commit style", "feedback"),
      "body", { accessed: "2026-07-20", count: 3, tier: "short" });
    const r = run(
      { prompt: "git commit style", cwd: dir },
      { CLAUDE_PLUGIN_ROOT: "/home/u/.codex/plugins/cache/cc-market/rem/1.0.0" },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  test("exits 0 on malformed stdin (never breaks the session)", () => {
    const r = spawnSync(process.execPath, [RECALL_JS], {
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
        "body ".repeat(50), { accessed: "2026-07-20", count: 1, tier: "short" });
    }
    const t0 = Date.now();
    const r = run({ prompt: "tell me about git", cwd: dir, session_id: "s1" });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.ok(elapsed < 2000, `took ${elapsed}ms`); // generous CI bound incl. node startup
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
      "body", { accessed: "2026-07-20", count: 1, tier: "short" });
    const r = spawnSync(process.execPath, [RECALL_JS], {
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
