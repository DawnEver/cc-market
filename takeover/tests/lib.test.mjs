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
  resolveModel,
  buildPrompt,
  extractText,
  parseCommandBlock,
  callAnthropicAPI,
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
