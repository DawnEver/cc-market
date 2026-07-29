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

import {
  tokenize,
  findScopeForCwd,
  isSkippable,
  collectCandidates,
  scoreEntry,
  selectTop,
  buildRecallContext,
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
