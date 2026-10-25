/**
 * Tests for sharp-review/hooks/sharp-review-hook.js — findGitRoot.
 * Run: node --test cc-market/sharp-review/tests/hook.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildDispatchInstruction,
  reviewBlocked,
  findGitRoot,
  resolveReviewWorkerTarget,
} from "../hooks/sharp-review-hook.js";
import { claimReview, completeReview } from '../scripts/gate.mjs';

describe('native lifecycle and deterministic review gate', () => {
  const snapshot = { sessionId: 's1', turnId: 't1', head: 'head', stat: { lines: 350, files: 5 }, wave: 0,
    sources: ['diff'], hashes: { diff: 'hash' }, reasons: { diff: 'threshold reached' } };

  test('every stop reevaluates content, including a session previously below threshold', () => {
    const result = claimReview({ sessionId: 's1', mode: 'none' }, snapshot, { token: 'claim', now: 100 });
    assert.equal(result.dispatch, true);
    assert.equal(result.gate.mode, 'once');
    assert.equal(result.gate.reviewedHashes, undefined, 'dispatch is not completion');
  });

  test('a pending checkout review excludes concurrent sessions and expired claims recover', () => {
    const first = claimReview({}, snapshot, { token: 'first', now: 100 });
    const second = claimReview(first.gate, { ...snapshot, sessionId: 's2' }, { token: 'second', now: 101 });
    assert.equal(second.dispatch, false);
    assert.equal(second.gate.pending.token, 'first');
    assert.equal(claimReview(first.gate, snapshot, { token: 'retry', now: first.gate.pending.expiresAt + 1 }).dispatch, true);
  });

  test('only a matching successful completion credits reviewed content', () => {
    const { gate } = claimReview({}, snapshot, { token: 'claim', now: 100 });
    assert.equal(completeReview(gate, 'other', true, 200), gate);
    const failed = completeReview(gate, 'claim', false, 200);
    assert.equal(failed.reviewedHashes, undefined);
    assert.equal(failed.pending, null);
    const completed = completeReview(gate, 'claim', true, 200);
    assert.deepEqual(completed.reviewedHashes, { diff: 'hash' });
    assert.equal(completed.lastReviewRef, 'head');
    assert.equal(claimReview(completed, snapshot, { token: 'next', now: 300 }).dispatch, false);
  });

  test('an expired matching review can release its reservation but cannot credit content', () => {
    const { gate } = claimReview({}, snapshot, { token: 'expired', now: 100 });
    const completed = completeReview(gate, 'expired', true, gate.pending.expiresAt);
    assert.equal(completed.pending, null);
    assert.equal(completed.reviewedHashes, undefined);
    assert.equal(completed.lastReviewRef, undefined);
  });

  test('native user waiting, continuation, active REM and project task deferral do not request review', () => {
    assert.equal(reviewBlocked({ stop_hook_active: true }, {}, {}, 100), true);
    assert.equal(reviewBlocked({}, { waitingForInput: true }, {}, 100), true);
    assert.equal(reviewBlocked({ session_id: 's1' }, {}, { hook: { sessions: { s1: { remPending: true, requestExpiresAt: 101 } } } }, 100), true);
    assert.equal(reviewBlocked({ session_id: 's1' }, {}, { hook: { sessions: { s1: { remPending: true, requestExpiresAt: 99 } } } }, 100), false);
    assert.equal(reviewBlocked({ session_id: 's2' }, {}, { hook: { sessions: { s1: { remPending: true } } } }, 100), false);
    assert.equal(reviewBlocked({ session_id: 's2' }, {}, { hook: { sessions: { s1: { remPending: true, requestExpiresAt: 101 } } } }, 100), true);
    assert.equal(reviewBlocked({ session_id: 's2' }, {}, { hook: { sessions: { s1: { remPending: true, requestExpiresAt: 99 } } } }, 100), false);
    assert.equal(reviewBlocked({}, {}, { hook: { taskActiveUntil: 101 } }, 100), true);
  });

  test('native Codex thread identity selects the built-in worker without CODEX_HOME', () => {
    assert.equal(resolveReviewWorkerTarget({ CODEX_THREAD_ID: 'thread' }).host, 'codex');
  });

  test('a live REM reservation excludes reviews from sibling execution threads too', () => {
    const state = { hook: { sessions: { child: { remPending: true, requestExpiresAt: 101 } } } };
    assert.equal(reviewBlocked({ session_id: 'parent', thread_id: 'child' }, {}, state, 100,
      { CODEX_THREAD_ID: 'stale' }), true);
    assert.equal(reviewBlocked({ session_id: 'parent', thread_id: 'sibling' }, {}, state, 100,
      { CODEX_THREAD_ID: 'child' }), true);
  });
});

test('Codex Stop reevaluates later edits, dispatches once, and does not invoke a Claude classifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-codex-stop-'));
  const hook = fileURLToPath(new URL('../hooks/sharp-review-hook.js', import.meta.url));
  const run = (extra = {}, env = {}) => spawnSync(process.execPath, [hook], {
    cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CODEX_HOME: dir, CODEX_THREAD_ID: 'stale', CLAUDE_PLUGIN_ROOT: '', ...env },
    input: JSON.stringify({ session_id: 'parent', thread_id: 'actual', turn_id: 'turn', hook_event_name: 'Stop', ...extra }),
    encoding: 'utf8', windowsHide: true,
  });
  try {
    execFileSync('git', ['init', '--quiet', dir], { windowsHide: true });
    fs.writeFileSync(path.join(dir, 'one.md'), 'one');
    assert.equal(run().status, 0, 'below threshold initially');
    fs.writeFileSync(path.join(dir, 'space name.md'), 'two');
    fs.writeFileSync(path.join(dir, 'résumé.md'), 'three');
    assert.equal(run({ thread_id: null }, { CODEX_THREAD_ID: '' }).status, 0, 'unknown thread never claims the parent');
    const dispatched = run();
    assert.equal(dispatched.status, 2, dispatched.stderr);
    assert.match(dispatched.stderr, /Dispatch ONE worker subagent/);
    assert.match(dispatched.stderr, /gateToken:/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude', '.rem-state.json')));
    assert.equal(state.reviewGate.pending.sessionId, 'actual');
    assert.equal(run().status, 0, 'an existing claim prevents repeat dispatch');
    assert.equal(run({ stop_hook_active: true }).status, 0);
    assert.doesNotMatch(fs.readFileSync(hook, 'utf8'), /spawnSync\(['"]claude/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe("findGitRoot", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (savedEnv) process.env.CLAUDE_PROJECT_DIR = savedEnv;
    else delete process.env.CLAUDE_PROJECT_DIR;
  });

  test("walks up from subdirectory to find .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      fs.mkdirSync(path.join(tmp, "sub"));
      assert.equal(findGitRoot(path.join(tmp, "sub")), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns dir itself when it has .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      assert.equal(findGitRoot(tmp), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns startDir unchanged when no .git found", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    try {
      assert.equal(findGitRoot(tmp), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("walks up multiple levels to find .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      const deep = path.join(tmp, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      assert.equal(findGitRoot(deep), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildDispatchInstruction", () => {
  test("resolves the dedicated sharp-review agent outside Codex", () => {
    assert.deepEqual(resolveReviewWorkerTarget({}), {
      agentType: "sharp-review:sharp-review",
      host: "claude",
      setup: "The worker executes directly",
      reason: "claude-dedicated-agent",
    });
  });

  test("resolves Codex to the built-in worker agent", () => {
    assert.deepEqual(resolveReviewWorkerTarget({ CODEX_HOME: "/tmp/codex" }), {
      agentType: "worker",
      host: "codex",
      setup: "Tell it to use the sharp-review skill",
      reason: "codex-built-in-worker",
    });
  });

  test("uses the dedicated sharp-review agent outside Codex", () => {
    const text = buildDispatchInstruction("diff", resolveReviewWorkerTarget({}));
    assert.match(text, /Dispatch ONE sharp-review:sharp-review subagent/);
    assert.match(text, /firedSources: diff/);
  });

  test("uses Codex worker subagent because plugin agent types are not registered", () => {
    const text = buildDispatchInstruction("diff", resolveReviewWorkerTarget({ CODEX_HOME: "/tmp/codex" }));
    assert.match(text, /Dispatch ONE worker subagent/);
    assert.match(text, /use the sharp-review skill/);
    assert.doesNotMatch(text, /sharp-review:sharp-review/);
  });
});

import { contentHash, freshSources, resolvePluginRoot } from "../hooks/sharp-review-hook.js";

describe("content-hash gate", () => {
  test("contentHash is independent of entry order and sensitive to content", () => {
    const a = contentHash([["x.lock", "d1"], ["y.lock", "d2"]]);
    assert.equal(a, contentHash([["y.lock", "d2"], ["x.lock", "d1"]]));
    assert.notEqual(a, contentHash([["x.lock", "d1"], ["y.lock", "d3"]]));
  });

  test("a source whose reviewed content is unchanged does not fire again", () => {
    // 2026-10-20: the deps profile re-fired every turn on an unchanged dirty tree.
    const hashes = { diff: "h-diff-2", deps: "h-deps" };
    const reviewed = { diff: "h-diff-1", deps: "h-deps" };
    assert.deepEqual(freshSources(["diff", "deps"], hashes, reviewed), ["diff"]);
    assert.deepEqual(freshSources(["deps"], hashes, reviewed), []);
    assert.deepEqual(freshSources(["deps"], hashes, {}), ["deps"]);
  });
});

describe("plugin root", () => {
  test("resolves to the directory holding scripts/plan.js and is named in the dispatch", () => {
    const root = resolvePluginRoot();
    assert.ok(fs.existsSync(path.join(root, "scripts", "plan.js")));
    const text = buildDispatchInstruction("diff", resolveReviewWorkerTarget({}), root);
    assert.ok(text.includes(`plugin root: ${root}`));
  });

  test("a root without the planner is refused by name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-"));
    try {
      assert.throws(() => resolvePluginRoot(tmp), /scripts\/plan\.js/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
