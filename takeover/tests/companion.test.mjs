/**
 * Tests for companion lib
 * Run: node --test takeover/tests/companion.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import {
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  parseArgs,
  extractText,
} from "../scripts/lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempSettings(obj) {
  const tmp = path.join(__dirname, `_tmp_settings_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj));
  return tmp;
}

// ── loadProviderConfig ────────────────────────────────────────────────────────

describe("loadProviderConfig", () => {
  test("returns native codex config without reading config file", () => {
    assert.deepEqual(loadProviderConfig("codex", "/nonexistent"), { native: true, provider: "codex" });
  });

  test("returns native claude config without reading config file", () => {
    assert.deepEqual(loadProviderConfig("claude", "/nonexistent"), { native: true, provider: "claude" });
  });

  test("returns API config for deepseek provider", () => {
    const p = makeTempSettings({
      "env:deepseek": {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "tok",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
      },
    });
    try {
      const result = loadProviderConfig("deepseek", p);
      assert.equal(result.native, false);
      assert.equal(result.token, "tok");
      assert.equal(result.baseUrl, "https://api.deepseek.com/anthropic");
      assert.equal(result.defaultSonnet, "deepseek-v4-flash");
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("throws when config file does not exist", () => {
    assert.throws(() => loadProviderConfig("deepseek", "/nonexistent/path.json"), /Config file not found/);
  });

  test("throws for unknown provider", () => {
    const p = makeTempSettings({});
    try {
      assert.throws(() => loadProviderConfig("unknown", p), /Provider "unknown" not found/);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("throws when ANTHROPIC_BASE_URL is missing", () => {
    const p = makeTempSettings({ "env:x": { ANTHROPIC_AUTH_TOKEN: "tok" } });
    try {
      assert.throws(() => loadProviderConfig("x", p), /missing ANTHROPIC_BASE_URL/);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("throws when ANTHROPIC_AUTH_TOKEN is missing", () => {
    const p = makeTempSettings({ "env:x": { ANTHROPIC_BASE_URL: "https://x.com" } });
    try {
      assert.throws(() => loadProviderConfig("x", p), /missing ANTHROPIC_AUTH_TOKEN/);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("parses --provider", () => {
    assert.equal(parseArgs(["--provider", "deepseek"]).options.provider, "deepseek");
  });

  test("parses --model", () => {
    assert.equal(parseArgs(["--model", "claude-opus-4-5"]).options.model, "claude-opus-4-5");
  });

  test("parses -m shorthand", () => {
    assert.equal(parseArgs(["-m", "gpt-4o"]).options.model, "gpt-4o");
  });

  test("parses --write", () => {
    assert.equal(parseArgs(["--write"]).options.write, true);
  });

  test("--write defaults to false", () => {
    assert.equal(parseArgs([]).options.write, false);
  });

  test("collects positionals as prompt", () => {
    assert.equal(parseArgs(["fix", "the", "bug"]).prompt, "fix the bug");
  });

  test("handles mixed flags and positionals", () => {
    const { options, prompt } = parseArgs(["--provider", "codex", "--model", "o4-mini", "--write", "do it"]);
    assert.equal(options.provider, "codex");
    assert.equal(options.model, "o4-mini");
    assert.equal(options.write, true);
    assert.equal(prompt, "do it");
  });

  test("-- stops flag parsing", () => {
    const { options, prompt } = parseArgs(["--provider", "ds", "--", "--not-a-flag", "text"]);
    assert.equal(options.provider, "ds");
    assert.equal(prompt, "--not-a-flag text");
  });

  test("throws when --provider has no value", () => {
    assert.throws(() => parseArgs(["--provider"]), /--provider requires a value/);
  });

  test("throws when --model has no value", () => {
    assert.throws(() => parseArgs(["--model"]), /--model requires a value/);
  });

  test("throws when --provider is followed by another flag", () => {
    assert.throws(() => parseArgs(["--provider", "--model", "x"]), /--provider requires a value/);
  });
});

// ── resolveModel ──────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  test("returns requested model when provided", () => {
    assert.equal(resolveModel({ defaultSonnet: "claude-sonnet-4-5" }, "claude-opus-4-5"), "claude-opus-4-5");
  });

  test("falls back to defaultSonnet", () => {
    assert.equal(resolveModel({ defaultSonnet: "claude-sonnet-4-5" }, null), "claude-sonnet-4-5");
  });

  test("returns undefined when no model and no defaultSonnet", () => {
    assert.equal(resolveModel({}, null), undefined);
  });
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("loads system prompt from real task.md template", () => {
    const { systemPrompt, userPrompt } = buildPrompt("task", "do stuff");
    assert.ok(systemPrompt.length > 0, "systemPrompt should be non-empty");
    assert.equal(userPrompt, "do stuff");
  });

  test("returns empty systemPrompt for unknown subcommand", () => {
    const { systemPrompt, userPrompt } = buildPrompt("nonexistent-xyz", "  my prompt  ");
    assert.equal(systemPrompt, "");
    assert.equal(userPrompt, "my prompt");
  });

  test("trims userPrompt whitespace", () => {
    assert.equal(buildPrompt("nonexistent-xyz", "  hello  ").userPrompt, "hello");
  });
});

// ── extractText ───────────────────────────────────────────────────────────────

describe("extractText", () => {
  test("extracts text from content blocks", () => {
    const data = { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] };
    assert.equal(extractText(data), "hello\nworld");
  });

  test("returns empty string for empty content", () => {
    assert.equal(extractText({ content: [] }), "");
  });

  test("returns empty string for missing content", () => {
    assert.equal(extractText({}), "");
  });

  test("skips non-text blocks", () => {
    const data = { content: [{ type: "tool_use", id: "x" }, { type: "text", text: "result" }] };
    assert.equal(extractText(data), "result");
  });
});

// ── callCodexCompanion (spawn behaviour via inline harness) ───────────────────

describe("callCodexCompanion spawn behaviour", () => {
  function makeCallCodexCompanion(spawnFn, execPath) {
    return function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false) {
      return new Promise((resolve, reject) => {
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
        const args = ["task"];
        if (writeMode) args.push("--write");
        if (model) args.push("--model", model);
        args.push(fullPrompt);
        const child = spawnFn(execPath, ["/fake/codex-companion.mjs", ...args], {
          env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 600000,
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
          else reject(new Error(`codex-companion exited ${code}: ${stderr.trim()}`));
        });
      });
    };
  }

  function fakeSpawn(output = "ok", exitCode = 0) {
    return (_cmd, _args, _opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        if (output) child.stdout.emit("data", output);
        child.emit("close", exitCode);
      });
      return child;
    };
  }

  test("passes --model when provided", (_t, done) => {
    const calls = [];
    const spy = (cmd, args, opts) => { calls.push(args); return fakeSpawn("out")(cmd, args, opts); };
    makeCallCodexCompanion(spy, process.execPath)("prompt", "", "o4-mini")
      .then(() => {
        assert.ok(calls[0].includes("--model"));
        assert.equal(calls[0][calls[0].indexOf("--model") + 1], "o4-mini");
        done();
      }).catch(done);
  });

  test("omits --model when null", (_t, done) => {
    const calls = [];
    const spy = (cmd, args, opts) => { calls.push(args); return fakeSpawn("out")(cmd, args, opts); };
    makeCallCodexCompanion(spy, process.execPath)("prompt", "", null)
      .then(() => { assert.ok(!calls[0].includes("--model")); done(); }).catch(done);
  });

  test("adds --write when writeMode is true", (_t, done) => {
    const calls = [];
    const spy = (cmd, args, opts) => { calls.push(args); return fakeSpawn("out")(cmd, args, opts); };
    makeCallCodexCompanion(spy, process.execPath)("prompt", "", null, true)
      .then(() => { assert.ok(calls[0].includes("--write")); done(); }).catch(done);
  });

  test("rejects on non-zero exit code", (_t, done) => {
    makeCallCodexCompanion(fakeSpawn("err", 1), process.execPath)("prompt", "", null)
      .then(() => done(new Error("should reject")))
      .catch((err) => { assert.match(err.message, /codex-companion exited 1/); done(); });
  });
});
