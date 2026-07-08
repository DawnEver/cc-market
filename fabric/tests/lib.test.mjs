/**
 * Tests for companion lib
 * Run: node --test cc-market/takeover/tests/companion.test.mjs
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadProviderConfig,
  clearConfigCache,
  getConfigPath,
  resolveModel,
  buildPrompt,
  extractText,
  parseCommandBlock,
  callAnthropicAPI,
  loadProviderEnv,
  logTakeoverRequest,
  TakeoverError,
  ConfigError,
  ProviderError,
  TimeoutError,
  AuthError,
  PROVIDER_ENV_KEYS,
  resolveClaudeExe,
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

  test("maps 'sonnet' tier name to provider's defaultSonnet", () => {
    assert.equal(resolveModel({ defaultSonnet: "deepseek-v4-flash" }, "sonnet"), "deepseek-v4-flash");
  });

  test("maps 'opus' tier name to provider's defaultOpus", () => {
    assert.equal(resolveModel({ defaultSonnet: "deepseek-v4-flash", defaultOpus: "deepseek-v4-pro" }, "opus"), "deepseek-v4-pro");
  });

  test("maps 'opus' to defaultSonnet when defaultOpus absent", () => {
    assert.equal(resolveModel({ defaultSonnet: "deepseek-v4-flash" }, "opus"), "deepseek-v4-flash");
  });

  test("maps 'haiku' tier name to provider's defaultHaiku", () => {
    assert.equal(resolveModel({ defaultSonnet: "ds-flash", defaultHaiku: "ds-haiku" }, "haiku"), "ds-haiku");
  });

  test("passes through non-tier model names unchanged", () => {
    assert.equal(resolveModel({ defaultSonnet: "deepseek-v4-flash" }, "deepseek-v4-pro"), "deepseek-v4-pro");
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

// ── parseCommandBlock ──────────────────────────────────────────────────────────

describe("parseCommandBlock", () => {
  test("extracts --provider and --model from command block", () => {
    const prompt = `<command>
--provider deepseek --model deepseek-v4-pro review the sharp review skill
</command>

<context>
some diff output
</context>`;
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "deepseek", model: "deepseek-v4-pro" });
    assert.ok(!result.cleanPrompt.includes("<command>"), "command block must be stripped");
    assert.ok(result.cleanPrompt.includes("<context>"), "context must be preserved");
    assert.ok(result.cleanPrompt.includes("some diff output"), "content must be preserved");
  });

  test("extracts only --provider when --model absent", () => {
    const prompt = `<command>
--provider claude do something
</command>

<context>x</context>`;
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "claude" });
    assert.equal("model" in result.flags, false);
  });

  test("extracts only --model when --provider absent", () => {
    const prompt = `<command>
--model deepseek-v4-pro do something
</command>

<context>x</context>`;
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { model: "deepseek-v4-pro" });
    assert.equal("provider" in result.flags, false);
  });

  test("returns empty flags and unmodified prompt when no command block", () => {
    const prompt = "plain text without any command block";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, {});
    assert.equal(result.cleanPrompt, prompt);
  });

  test("handles compact single-line command block", () => {
    const prompt = "<command>--provider deepseek --model x task here</command>\n\n<context>ctx</context>";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "deepseek", model: "x" });
    assert.ok(!result.cleanPrompt.includes("<command>"));
  });

  test("preserves text after command block even without <context> tags", () => {
    const prompt = "<command>\n--provider deepseek review this\n</command>\n\nPlease analyze the code.";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "deepseek" });
    assert.ok(result.cleanPrompt.includes("Please analyze the code"));
  });
});

// ── parseCommandBlock (mode flags) ──────────────────────────────────────────────

describe("parseCommandBlock mode flags", () => {
  test("detects --review flag", () => {
    const { flags } = parseCommandBlock("<command>\n--provider codex --review\n</command>\ncheck this code");
    assert.equal(flags.mode, "review");
    assert.equal(flags.provider, "codex");
  });

  test("detects --image flag", () => {
    const { flags } = parseCommandBlock("<command>\n--provider codex --image\n</command>\na sunset");
    assert.equal(flags.mode, "image-generate");
  });

  test("detects --image-edit flag (takes precedence over --image)", () => {
    const { flags } = parseCommandBlock("<command>\n--provider codex --image-edit\n</command>\nedit photo.png");
    assert.equal(flags.mode, "image-edit");
  });

  test("no mode flag defaults to undefined", () => {
    const { flags } = parseCommandBlock("<command>\n--provider deepseek\n</command>\nreview this PR");
    assert.equal(flags.mode, undefined);
    assert.equal(flags.provider, "deepseek");
  });

  test("--review combined with --model", () => {
    const { flags } = parseCommandBlock("<command>\n--provider codex --review --model gpt-5.1\n</command>\n");
    assert.equal(flags.mode, "review");
    assert.equal(flags.model, "gpt-5.1");
  });
});

// ── callAnthropicAPI ──────────────────────────────────────────────────────────

describe("callAnthropicAPI", () => {
  test("constructs correct URL from baseUrl (strips trailing slash)", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "response" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      await callAnthropicAPI(
        { baseUrl: "https://api.example.com/anthropic/", token: "sk-test" },
        "test-model",
        "sys",
        "user"
      );
      assert.equal(fetches.length, 1);
      assert.equal(fetches[0].url, "https://api.example.com/anthropic/messages");
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("sends correct headers", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "response" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      await callAnthropicAPI(
        { baseUrl: "https://api.example.com", token: "sk-secret" },
        "test-model",
        null,
        "user"
      );
      assert.equal(fetches[0].init.headers["Content-Type"], "application/json");
      assert.equal(fetches[0].init.headers["x-api-key"], "sk-secret");
      assert.equal(fetches[0].init.headers["anthropic-version"], "2023-06-01");
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("includes system prompt in body when provided", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "response" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      await callAnthropicAPI(
        { baseUrl: "https://api.example.com", token: "sk-test" },
        "test-model",
        "you are helpful",
        "user prompt"
      );
      const body = JSON.parse(fetches[0].init.body);
      assert.equal(body.system, "you are helpful");
      assert.equal(body.messages[0].content, "user prompt");
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("omits system field when systemPrompt is null", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "response" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      await callAnthropicAPI(
        { baseUrl: "https://api.example.com", token: "sk-test" },
        "test-model",
        "",
        "user"
      );
      const body = JSON.parse(fetches[0].init.body);
      assert.equal("system" in body, false);
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    }));

    try {
      await assert.rejects(
        () => callAnthropicAPI({ baseUrl: "https://api.example.com", token: "sk-test" }, "model", null, "user"),
        /API error 400/
      );
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("retries on 429 rate limit", async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount < 3) return { ok: false, status: 429, text: async () => "Rate limited" };
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "finally" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      const result = await callAnthropicAPI({ baseUrl: "https://api.example.com", token: "sk-test" }, "model", null, "user");
      assert.equal(callCount, 3);
      assert.equal(extractText(result), "finally");
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("retries on 502/503/504", async () => {
    for (const status of [502, 503, 504]) {
      let callCount = 0;
      globalThis.fetch = mock.fn(async () => {
        callCount++;
        if (callCount === 1) return { ok: false, status, text: async () => "Server error" };
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
        };
      });

      try {
        await callAnthropicAPI({ baseUrl: "https://api.example.com", token: "sk-test" }, "model", null, "user");
        assert.equal(callCount, 2, `expected 2 calls for status ${status}, got ${callCount}`);
      } finally {
        globalThis.fetch = undefined;
      }
    }
  });

  test("does not retry on 400 client error", async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      return { ok: false, status: 400, text: async () => "Bad request" };
    });

    try {
      await assert.rejects(
        () => callAnthropicAPI({ baseUrl: "https://api.example.com", token: "sk-test" }, "model", null, "user"),
        /API error 400/
      );
      assert.equal(callCount, 1);
    } finally {
      globalThis.fetch = undefined;
    }
  });
});

// ── loadProviderEnv ─────────────────────────────────────────────────────────

describe("loadProviderEnv", () => {
  test("clears all provider keys for non-claude provider", () => {
    // Set known provider keys in process.env
    process.env.ANTHROPIC_BASE_URL = 'https://original.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'orig-token';

    const tmp = makeTempSettings({ "env:test": {
      ANTHROPIC_BASE_URL: "https://test.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-test",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "test-sonnet",
    }});

    try {
      const env = loadProviderEnv("test", tmp);
      assert.equal(env.ANTHROPIC_BASE_URL, "https://test.example.com");
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "test-sonnet");
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      fs.unlinkSync(tmp);
    }
  });

  test("returns empty env for claude provider (OAuth/Pro)", () => {
    process.env.ANTHROPIC_BASE_URL = 'https://stale.example.com';
    try {
      const env = loadProviderEnv("claude");
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  test("throws for unknown provider", () => {
    const tmp = makeTempSettings({ "env:known": { ANTHROPIC_BASE_URL: "u", ANTHROPIC_AUTH_TOKEN: "t" }});
    try {
      assert.throws(
        () => loadProviderEnv("unknown", tmp),
        /Provider "unknown" not found/
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ── PROVIDER_ENV_KEYS ───────────────────────────────────────────────────────

describe("PROVIDER_ENV_KEYS", () => {
  test("includes all cc.js provider keys", () => {
    const required = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY'];
    for (const key of required) {
      assert.ok(PROVIDER_ENV_KEYS.includes(key), `Missing key: ${key}`);
    }
  });

  test("includes model tier keys", () => {
    const tiers = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
    for (const key of tiers) {
      assert.ok(PROVIDER_ENV_KEYS.includes(key), `Missing tier key: ${key}`);
    }
  });
});

describe("resolveClaudeExe", () => {
  test("honors CLAUDE_CLI_PATH override", () => {
    const prev = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = "/custom/path/to/claude";
    try {
      assert.equal(resolveClaudeExe(), "/custom/path/to/claude");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = prev;
    }
  });

  test("returns plain 'claude' on non-win32 without override", (t) => {
    if (process.platform === "win32") return t.skip("win32");
    const prev = process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    try {
      assert.equal(resolveClaudeExe(), "claude");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CLI_PATH = prev;
    }
  });

  test("resolves an existing claude.exe on win32", (t) => {
    if (process.platform !== "win32") return t.skip("non-win32");
    const prev = process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    try {
      const p = resolveClaudeExe();
      // Either derived from PATH (exists) or the legacy fallback path string.
      assert.ok(p.endsWith("claude.exe"));
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CLI_PATH = prev;
    }
  });
});

// ── Config caching ──────────────────────────────────────────────────────────

describe("loadProviderConfig caching", () => {
  test("returns cached result on second call within TTL", () => {
    clearConfigCache();
    const tmp = makeTempSettings({ "env:cachetest": {
      ANTHROPIC_BASE_URL: "https://cache.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-cache",
    }});
    try {
      const r1 = loadProviderConfig("cachetest", tmp);
      const r2 = loadProviderConfig("cachetest", tmp);
      assert.equal(r2.baseUrl, "https://cache.example.com");
      assert.equal(r2.token, "sk-cache");
    } finally {
      clearConfigCache();
      fs.unlinkSync(tmp);
    }
  });

  test("clearConfigCache forces re-read", () => {
    clearConfigCache();
    const tmp = makeTempSettings({ "env:cachetest2": {
      ANTHROPIC_BASE_URL: "https://first.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-first",
    }});
    try {
      const r1 = loadProviderConfig("cachetest2", tmp);
      assert.equal(r1.baseUrl, "https://first.example.com");
      clearConfigCache();
      // Modify config file and re-read
      fs.writeFileSync(tmp, JSON.stringify({ "env:cachetest2": {
        ANTHROPIC_BASE_URL: "https://second.example.com", ANTHROPIC_AUTH_TOKEN: "sk-second"
      }}));
      const r2 = loadProviderConfig("cachetest2", tmp);
      assert.equal(r2.baseUrl, "https://second.example.com");
    } finally {
      clearConfigCache();
      fs.unlinkSync(tmp);
    }
  });
});

// ── getConfigPath ────────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("evaluates TAKEOVER_CONFIG_PATH at call time", () => {
    // Default path
    const defaultPath = getConfigPath();
    assert.ok(defaultPath.includes("claude_env_settings.json"));

    // Override via env
    process.env.TAKEOVER_CONFIG_PATH = "/custom/path/config.json";
    try {
      assert.equal(getConfigPath(), "/custom/path/config.json");
    } finally {
      delete process.env.TAKEOVER_CONFIG_PATH;
    }

    // After clearing, returns to default
    assert.equal(getConfigPath(), defaultPath);
  });
});

// ── Error taxonomy ──────────────────────────────────────────────────────────

describe("TakeoverError classes", () => {
  test("ConfigError has correct code and non-retryable", () => {
    const e = new ConfigError("bad config");
    assert.ok(e instanceof TakeoverError);
    assert.ok(e instanceof Error);
    assert.equal(e.code, "CONFIG_ERROR");
    assert.equal(e.retryable, false);
    assert.equal(e.message, "bad config");
  });

  test("ProviderError has configurable retryable", () => {
    const e1 = new ProviderError("provider down", true);
    assert.equal(e1.code, "PROVIDER_ERROR");
    assert.equal(e1.retryable, true);

    const e2 = new ProviderError("bad response");
    assert.equal(e2.retryable, false);
  });

  test("TimeoutError is retryable", () => {
    const e = new TimeoutError("timed out");
    assert.equal(e.code, "TIMEOUT_ERROR");
    assert.equal(e.retryable, true);
  });

  test("AuthError is non-retryable", () => {
    const e = new AuthError("invalid key");
    assert.equal(e.code, "AUTH_ERROR");
    assert.equal(e.retryable, false);
  });

  test("TakeoverError base defaults", () => {
    const e = new TakeoverError("generic");
    assert.equal(e.code, "TAKEOVER_ERROR");
    assert.equal(e.retryable, false);
  });
});

// ── Structured logging ───────────────────────────────────────────────────────

describe("logTakeoverRequest", () => {
  test("emits valid ndjson to stderr", () => {
    let captured;
    const orig = process.stderr.write;
    process.stderr.write = (data) => { captured = data; return true; };
    try {
      logTakeoverRequest("2026-06-12T10:00:00Z", "deepseek", "sonnet", "task", "ok", { durationMs: 1234, inputTokens: 500, outputTokens: 300 });
      assert.ok(captured, "should emit a log line");
      const entry = JSON.parse(captured);
      assert.equal(entry.provider, "deepseek");
      assert.equal(entry.model, "sonnet");
      assert.equal(entry.mode, "task");
      assert.equal(entry.status, "ok");
      assert.equal(entry.duration_ms, 1234);
      assert.equal(entry.input_tokens, 500);
      assert.equal(entry.output_tokens, 300);
      assert.ok(entry.request_id?.startsWith("tk-"));
    } finally {
      process.stderr.write = orig;
    }
  });

  test("includes error field on error status", () => {
    let captured;
    const orig = process.stderr.write;
    process.stderr.write = (data) => { captured = data; return true; };
    try {
      logTakeoverRequest("2026-06-12T10:00:00Z", "codex", "default", "review", "error", { durationMs: 5000, error: "timeout after 30s" });
      const entry = JSON.parse(captured);
      assert.equal(entry.status, "error");
      assert.equal(entry.error, "timeout after 30s");
    } finally {
      process.stderr.write = orig;
    }
  });
});
