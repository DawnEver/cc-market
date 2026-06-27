/**
 * Tests for sharp-review/hooks/sharp-review-hook.js — findGitRoot.
 * Run: node --test cc-market/sharp-review/tests/hook.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildDispatchInstruction,
  findGitRoot,
  resolveReviewWorkerTarget,
} from "../hooks/sharp-review-hook.js";

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
