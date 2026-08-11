import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { findCodexBinary, checkCodexStatus } from "../engine/codex/discovery.mjs";

describe("findCodexBinary", () => {
  test("returns override from TAKEOVER_CODEX_BINARY", () => {
    const orig = process.env.TAKEOVER_CODEX_BINARY;
    process.env.TAKEOVER_CODEX_BINARY = process.execPath;
    try {
      const result = findCodexBinary();
      assert.equal(result, process.execPath);
    } finally {
      if (orig) process.env.TAKEOVER_CODEX_BINARY = orig;
      else delete process.env.TAKEOVER_CODEX_BINARY;
    }
  });

  test("throws when TAKEOVER_CODEX_BINARY points to missing file", () => {
    const orig = process.env.TAKEOVER_CODEX_BINARY;
    process.env.TAKEOVER_CODEX_BINARY = "/nonexistent/codex";
    try {
      assert.throws(() => findCodexBinary(), /TAKEOVER_CODEX_BINARY not found/);
    } finally {
      if (orig) process.env.TAKEOVER_CODEX_BINARY = orig;
      else delete process.env.TAKEOVER_CODEX_BINARY;
    }
  });
});

describe("checkCodexStatus", () => {
  test("returns installed=false when binary fails", () => {
    const result = checkCodexStatus("/nonexistent/codex");
    assert.equal(result.installed, false);
  });

  test("accepts explicit path parameter", () => {
    const result = checkCodexStatus("/nonexistent/codex/binary");
    assert.equal(result.installed, false);
  });
});

describe("checkCodexStatusAsync (the console's non-blocking twin)", () => {
  test("nonexistent binary reports installed=false, never rejects", async () => {
    const { checkCodexStatusAsync } = await import("../engine/codex/discovery.mjs");
    const r = await checkCodexStatusAsync("/nonexistent/codex/bin");
    assert.equal(r.installed, false);
    assert.ok(r.error);
  });

  test("honors TAKEOVER_CODEX_BINARY override", async () => {
    const { findCodexBinaryAsync } = await import("../engine/codex/discovery.mjs");
    const orig = process.env.TAKEOVER_CODEX_BINARY;
    process.env.TAKEOVER_CODEX_BINARY = process.execPath;
    try {
      const bin = await findCodexBinaryAsync();
      assert.equal(bin, process.execPath);
    } finally {
      if (orig) process.env.TAKEOVER_CODEX_BINARY = orig;
      else delete process.env.TAKEOVER_CODEX_BINARY;
    }
  });
});
