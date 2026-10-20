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
  getConfigPath,
  resolveModel,
  buildPrompt,
  extractText,
  truncateText,
  parseCommandBlock,
  callAnthropicAPI,
  logProviderRequest,
  ConfigError,
  ProviderError,
  ERROR_KINDS,
  httpErrorKind,
  PROVIDER_ENV_KEYS,
  resolveClaudeExe,
} from "../scripts/lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


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
    assert.equal(resolveModel({ defaultSonnet: "acme-flash" }, "sonnet"), "acme-flash");
  });

  test("maps 'opus' tier name to provider's defaultOpus", () => {
    assert.equal(resolveModel({ defaultSonnet: "acme-flash", defaultOpus: "acme-pro" }, "opus"), "acme-pro");
  });

  test("maps 'opus' to defaultSonnet when defaultOpus absent", () => {
    assert.equal(resolveModel({ defaultSonnet: "acme-flash" }, "opus"), "acme-flash");
  });

  test("maps 'haiku' tier name to provider's defaultHaiku", () => {
    assert.equal(resolveModel({ defaultSonnet: "ds-flash", defaultHaiku: "ds-haiku" }, "haiku"), "ds-haiku");
  });

  test("passes through non-tier model names unchanged", () => {
    assert.equal(resolveModel({ defaultSonnet: "acme-flash" }, "acme-pro"), "acme-pro");
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

// ── truncateText ─────────────────────────────────────────────────────────────

describe("truncateText", () => {
  test("returns text unchanged when under limit", () => {
    assert.equal(truncateText("hello", 100), "hello");
  });

  test("truncates and appends notice when over limit", () => {
    const result = truncateText("a".repeat(100), 50);
    assert.ok(result.startsWith("a".repeat(50)));
    assert.ok(result.includes("[...truncated 50 chars"));
  });

  test("returns text unchanged when maxChars is 0 (unlimited)", () => {
    const long = "a".repeat(5000);
    assert.equal(truncateText(long, 0), long);
  });

  test("returns text unchanged when maxChars is negative", () => {
    assert.equal(truncateText("hello", -1), "hello");
  });

  test("handles null/undefined text", () => {
    assert.equal(truncateText(null, 100), null);
    assert.equal(truncateText(undefined, 100), undefined);
  });
});

// ── parseCommandBlock ──────────────────────────────────────────────────────────

describe("parseCommandBlock", () => {
  test("extracts --provider and --model from command block", () => {
    const prompt = `<command>
--provider acme --model acme-pro review the sharp review skill
</command>

<context>
some diff output
</context>`;
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "acme", model: "acme-pro" });
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
--model acme-pro do something
</command>

<context>x</context>`;
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { model: "acme-pro" });
    assert.equal("provider" in result.flags, false);
  });

  test("returns empty flags and unmodified prompt when no command block", () => {
    const prompt = "plain text without any command block";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, {});
    assert.equal(result.cleanPrompt, prompt);
  });

  test("handles compact single-line command block", () => {
    const prompt = "<command>--provider acme --model x task here</command>\n\n<context>ctx</context>";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "acme", model: "x" });
    assert.ok(!result.cleanPrompt.includes("<command>"));
  });

  test("preserves text after command block even without <context> tags", () => {
    const prompt = "<command>\n--provider acme review this\n</command>\n\nPlease analyze the code.";
    const result = parseCommandBlock(prompt);
    assert.deepEqual(result.flags, { provider: "acme" });
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
    const { flags } = parseCommandBlock("<command>\n--provider acme\n</command>\nreview this PR");
    assert.equal(flags.mode, undefined);
    assert.equal(flags.provider, "acme");
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
      assert.equal(fetches[0].url, "https://api.example.com/anthropic/v1/messages");
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

// ── PROVIDER_ENV_KEYS ───────────────────────────────────────────────────────

describe("PROVIDER_ENV_KEYS", () => {
  test("includes all cc.js provider keys", () => {
    // The current set (Foundry keys were removed when the project migrated off
    // Foundry mode — see providers.md § Direct Anthropic-compatible providers).
    const required = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
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


// ── getConfigPath ────────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("evaluates CC_MARKET_CONFIG_PATH at call time", () => {
    // Default path
    const defaultPath = getConfigPath();
    assert.ok(defaultPath.includes("claude_env_settings.json"));

    // Override via env
    process.env.CC_MARKET_CONFIG_PATH = "/custom/path/config.json";
    try {
      assert.equal(getConfigPath(), "/custom/path/config.json");
    } finally {
      delete process.env.CC_MARKET_CONFIG_PATH;
    }

    // After clearing, returns to default
    assert.equal(getConfigPath(), defaultPath);
  });
});

// ── Error taxonomy ──────────────────────────────────────────────────────────

describe("error taxonomy", () => {
  test("ProviderError carries one of the declared kinds", () => {
    assert.deepEqual(ERROR_KINDS, ["exhausted", "auth", "rate_limit", "timeout", "unsupported", "failed"]);
    for (const kind of ERROR_KINDS) {
      const e = new ProviderError(kind, "boom");
      assert.equal(e.kind, kind);
      assert.equal(e.message, `[${kind}] boom`);
    }
  });

  test("an HTTP status maps to its kind", () => {
    assert.equal(httpErrorKind(401), "auth");
    assert.equal(httpErrorKind(403), "auth");
    assert.equal(httpErrorKind(402), "exhausted");
    assert.equal(httpErrorKind(429), "rate_limit");
    assert.equal(httpErrorKind(400), "failed");
    assert.equal(httpErrorKind(503), "failed");
  });

  test("a non-OK API response is a classified ProviderError", async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 401, text: async () => "invalid x-api-key" }));
    try {
      await assert.rejects(
        () => callAnthropicAPI({ baseUrl: "https://api.example.com", token: "sk-test" }, "model", null, "user"),
        (e) => e.kind === "auth" && /API error 401/.test(e.message));
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("an undeclared kind is refused by name", () => {
    assert.throws(() => new ProviderError("quota", "x"), /undeclared error kind "quota"/);
  });

  test("ConfigError is a caller mistake, not a provider kind", () => {
    const e = new ConfigError("bad config");
    assert.ok(e instanceof Error);
    assert.equal(e.kind, undefined);
    assert.equal(e.message, "bad config");
  });

  test("the retired classes are gone", async () => {
    const lib = await import("../scripts/lib.mjs");
    for (const name of ["TakeoverError", "TimeoutError", "AuthError"]) assert.equal(lib[name], undefined, name);
  });
});

// ── Structured logging ───────────────────────────────────────────────────────

describe("logProviderRequest", () => {
  test("emits valid ndjson to stderr", () => {
    let captured;
    const orig = process.stderr.write;
    process.stderr.write = (data) => { captured = data; return true; };
    try {
      logProviderRequest("2026-06-12T10:00:00Z", "acme", "sonnet", "task", "ok", { durationMs: 1234, inputTokens: 500, outputTokens: 300 });
      assert.ok(captured, "should emit a log line");
      const entry = JSON.parse(captured);
      assert.equal(entry.provider, "acme");
      assert.equal(entry.model, "sonnet");
      assert.equal(entry.mode, "task");
      assert.equal(entry.status, "ok");
      assert.equal(entry.duration_ms, 1234);
      assert.equal(entry.input_tokens, 500);
      assert.equal(entry.output_tokens, 300);
      assert.ok(entry.request_id?.startsWith("fb-"));
    } finally {
      process.stderr.write = orig;
    }
  });

  test("includes error field on error status", () => {
    let captured;
    const orig = process.stderr.write;
    process.stderr.write = (data) => { captured = data; return true; };
    try {
      logProviderRequest("2026-06-12T10:00:00Z", "codex", "default", "review", "error", { durationMs: 5000, error: "timeout after 30s" });
      const entry = JSON.parse(captured);
      assert.equal(entry.status, "error");
      assert.equal(entry.error, "timeout after 30s");
    } finally {
      process.stderr.write = orig;
    }
  });
});
