/**
 * Tests for rem/hooks/rem-hook.js — state machine and decision logic.
 * Run: node --test cc-market/rem/tests/rem-hook.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  isFreshSession,
  hasSubstantiveWork,
  readTranscriptTail,
  decideStop,
} from "../hooks/rem-hook.js";

// ── Constants expected from rem-hook.js ──
const MIN_STOP_COUNT = 3;
const MIN_SESSION_MS = 2 * 60 * 1000;
const MIN_SESSION_MS_SUBSTANTIVE = 30 * 1000;
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

// ── isFreshSession ─────────────────────────────────────────────────────────────

describe("isFreshSession", () => {
  test("returns true for null/undefined state", () => {
    assert.equal(isFreshSession(null, "key-1", Date.now()), true);
    assert.equal(isFreshSession(undefined, "key-1", Date.now()), true);
  });

  test("returns true when sessionKey differs", () => {
    const state = {
      hook: { sessionKey: "old-key", lastTouched: Date.now() },
    };
    assert.equal(isFreshSession(state, "new-key", Date.now()), true);
  });

  test("returns false when null input key with stored key (treated as same session)", () => {
    const state = {
      hook: { sessionKey: "old-key", lastTouched: Date.now() },
    };
    assert.equal(isFreshSession(state, null, Date.now()), false);
  });

  test("returns true when expired (>30 min since last touch)", () => {
    const state = {
      hook: {
        sessionKey: "key-1",
        lastTouched: Date.now() - SESSION_EXPIRY_MS - 1,
      },
    };
    assert.equal(isFreshSession(state, "key-1", Date.now()), true);
  });

  test("returns false when same session within expiry", () => {
    const state = {
      hook: { sessionKey: "key-1", lastTouched: Date.now() },
    };
    assert.equal(isFreshSession(state, "key-1", Date.now()), false);
  });

  test("returns false when both keys are null", () => {
    const state = {
      hook: { sessionKey: null, lastTouched: Date.now() },
    };
    assert.equal(isFreshSession(state, null, Date.now()), false);
  });

  test("handles missing lastTouched (treats as 0 → expired)", () => {
    const state = {
      hook: { sessionKey: "key-1" },
    };
    assert.equal(isFreshSession(state, "key-1", SESSION_EXPIRY_MS + 100), true);
  });
});

// ── hasSubstantiveWork ─────────────────────────────────────────────────────────

describe("hasSubstantiveWork", () => {
  test("returns true when Edit found", () => {
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    ];
    assert.equal(hasSubstantiveWork(transcript), true);
  });

  test("returns true when Write found", () => {
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Write", input: {} }] } },
    ];
    assert.equal(hasSubstantiveWork(transcript), true);
  });

  test("returns true when NotebookEdit found", () => {
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "NotebookEdit", input: {} }] } },
    ];
    assert.equal(hasSubstantiveWork(transcript), true);
  });

  test("returns false for read-only tools (Read, Grep, Glob)", () => {
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
      { message: { content: [{ type: "tool_use", name: "Grep", input: {} }] } },
    ];
    assert.equal(hasSubstantiveWork(transcript), false);
  });

  test("returns false for empty transcript", () => {
    assert.equal(hasSubstantiveWork([]), false);
  });

  test("returns false when content is not array", () => {
    const transcript = [
      { message: { content: "plain text" } },
    ];
    assert.equal(hasSubstantiveWork(transcript), false);
  });

  test("returns false when message has no content", () => {
    const transcript = [{ message: {} }];
    assert.equal(hasSubstantiveWork(transcript), false);
  });

  test("returns false when entry has no message", () => {
    const transcript = [{ other: "data" }];
    assert.equal(hasSubstantiveWork(transcript), false);
  });

  test("finds substantive work across multiple entries", () => {
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
      { message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    ];
    assert.equal(hasSubstantiveWork(transcript), true);
  });
});

// ── readTranscriptTail ─────────────────────────────────────────────────────────

describe("readTranscriptTail", () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-hook-test-"));
    tmpFile = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses the last N lines", () => {
    const lines = [];
    for (let i = 1; i <= 50; i++) {
      lines.push(JSON.stringify({ index: i, message: { content: [] } }));
    }
    fs.writeFileSync(tmpFile, lines.join("\n"));
    const result = readTranscriptTail(tmpFile, 5);
    assert.equal(result.length, 5);
    assert.equal(result[0].index, 46);
    assert.equal(result[4].index, 50);
  });

  test("returns empty array for non-existent file", () => {
    assert.deepEqual(readTranscriptTail("/nonexistent/path.jsonl"), []);
  });

  test("returns empty array for empty file", () => {
    fs.writeFileSync(tmpFile, "");
    assert.deepEqual(readTranscriptTail(tmpFile), []);
  });

  test("skips invalid JSON lines", () => {
    const lines = [
      JSON.stringify({ valid: true }),
      "not valid json {",
      JSON.stringify({ also: "valid" }),
    ];
    fs.writeFileSync(tmpFile, lines.join("\n"));
    const result = readTranscriptTail(tmpFile, 10);
    assert.equal(result.length, 2);
  });
});

// ── decideStop ─────────────────────────────────────────────────────────────────

describe("decideStop", () => {
  test("fresh session initializes and increments stopCount to 1", () => {
    const now = Date.now();
    const { state, decision } = decideStop(
      { hook: { sessionKey: null, stopCount: 0, firstStopAt: null, remPending: false, remDone: false, lastTouched: 0, taskActiveUntil: null } },
      { session_id: "s1" },
      now
    );
    // Fresh session resets to 0, then this stop increments to 1
    assert.equal(state.hook.stopCount, 1);
    assert.equal(state.hook.sessionKey, "s1");
    assert.equal(state.hook.remDone, false);
    assert.equal(state.hook.remPending, false);
    assert.equal(decision, "allow");
  });

  test("increments stopCount on subsequent stops", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 0, firstStopAt: now - 60000, remPending: false, remDone: false, lastTouched: now - 60000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1" }, now);
    assert.equal(result.state.hook.stopCount, 1);
    assert.equal(result.decision, "allow");
  });

  test("does not increment stopCount when background tasks are pending", () => {
    const now = Date.now();
    const state = { hook: { sessionKey: "s1", stopCount: 2, firstStopAt: now - 180000, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1", background_tasks: ["task-1"] }, now);
    assert.equal(result.state.hook.stopCount, 2); // unchanged
    assert.equal(result.decision, "allow");
  });

  test("does not increment stopCount when taskActiveUntil not reached", () => {
    const now = Date.now();
    const state = { hook: { sessionKey: "s1", stopCount: 2, firstStopAt: now - 180000, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: now + 60000 } };
    const result = decideStop(state, { session_id: "s1" }, now);
    assert.equal(result.state.hook.stopCount, 2); // unchanged
    assert.equal(result.decision, "allow");
  });

  test("denies stop when stopCount >= 3 AND sessionAge >= 2 min (non-substantive)", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - MIN_SESSION_MS, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1", transcript_path: "/nonexistent" }, now);
    assert.equal(result.decision, "deny");
    assert.equal(result.state.hook.remPending, true);
  });

  test("denies stop when stopCount >= 3 AND sessionAge >= 30s (substantive work)", () => {
    const now = Date.now();
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    ];
    let tmpDir, tmpFile;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-hook-test-"));
      tmpFile = path.join(tmpDir, "transcript.jsonl");
      fs.writeFileSync(tmpFile, transcript.map(JSON.stringify).join("\n"));

      let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - MIN_SESSION_MS_SUBSTANTIVE, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
      const result = decideStop(state, { session_id: "s1", transcript_path: tmpFile }, now);
      assert.equal(result.decision, "deny");
      assert.equal(result.state.hook.remPending, true);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("allows stop when stopCount after increment < 3", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 1, firstStopAt: now - 300000, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1" }, now);
    // stopCount becomes 2 after increment, which is < MIN_STOP_COUNT (3)
    assert.equal(result.decision, "allow");
  });

  test("allows stop when sessionAge < minimum but stopCount >= 3", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - 1000, remPending: false, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1", transcript_path: "/nonexistent" }, now);
    assert.equal(result.decision, "allow");
  });

  test("allows stop when remDone is true", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 5, firstStopAt: now - 300000, remPending: false, remDone: true, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1" }, now);
    assert.equal(result.decision, "allow");
  });

  test("allows stop and clears remPending when it was set", () => {
    const now = Date.now();
    let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - 300000, remPending: true, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
    const result = decideStop(state, { session_id: "s1", transcript_path: "/nonexistent" }, now);
    assert.equal(result.decision, "allow");
    assert.equal(result.state.hook.remPending, false);
  });

  test("sets remDone when transcript shows Skill tool call for 'rem'", () => {
    const now = Date.now();
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "rem" } }] } },
    ];
    let tmpDir, tmpFile;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-hook-test-"));
      tmpFile = path.join(tmpDir, "transcript.jsonl");
      fs.writeFileSync(tmpFile, transcript.map(JSON.stringify).join("\n"));

      let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - 300000, remPending: true, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
      const result = decideStop(state, { session_id: "s1", transcript_path: tmpFile }, now);
      assert.equal(result.decision, "allow");
      assert.equal(result.state.hook.remDone, true);
      assert.equal(result.state.hook.remPending, false);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not set remDone when Skill call is not 'rem'", () => {
    const now = Date.now();
    const transcript = [
      { message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "other-skill" } }] } },
    ];
    let tmpDir, tmpFile;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-hook-test-"));
      tmpFile = path.join(tmpDir, "transcript.jsonl");
      fs.writeFileSync(tmpFile, transcript.map(JSON.stringify).join("\n"));

      let state = { hook: { sessionKey: "s1", stopCount: 3, firstStopAt: now - 300000, remPending: true, remDone: false, lastTouched: now - 1000, taskActiveUntil: null } };
      const result = decideStop(state, { session_id: "s1", transcript_path: tmpFile }, now);
      assert.equal(result.state.hook.remDone, false);
      assert.equal(result.state.hook.remPending, false);
      assert.equal(result.decision, "allow");
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
