// Tests for the fabric MCP server — unified `call` primitive (ex takeover call_model ∪ fabric
// run_task), fan_out, and provider introspection. No real claude/codex/
// network: `call` dispatch is validated via schema + routing + <command> parsing + injected
// fakes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLS, handleToolCall, handleCall, handleFanOut, encodeRpcMessage,
  API_DISPATCH, CLAUDE_DISPATCH, CODEX_DISPATCH, FAN_OUT_CONCURRENCY_DEFAULT,
} from "../scripts/mcp-server.mjs";
import { providerCacheFixture, fixtureKeySource } from "./fixtures/provider-cache.mjs";
import { _setKeySource } from "../engine/providers.mjs";

_setKeySource(fixtureKeySource());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "scripts", "mcp-server.mjs");
const text = (r) => r.content[0].text;

// Hermetic registry + provider cache: CC_MARKET_CONFIG_PATH points at a temp fixture for the
// whole file, so no test reads the host's ~/.claude; withConfigFixture swaps in a registry.
process.env.CC_MARKET_CONFIG_PATH = providerCacheFixture().configPath;
function withConfigFixture(registry, fn) {
  const prev = process.env.CC_MARKET_CONFIG_PATH;
  process.env.CC_MARKET_CONFIG_PATH = providerCacheFixture({ registry }).configPath;
  return Promise.resolve().then(fn).finally(() => { process.env.CC_MARKET_CONFIG_PATH = prev; });
}

const ACME_FIXTURE = { providers: { acme: { claudeApiKeyEnv: "ANTHROPIC_AUTH_TOKEN" } } };

function parseFramedMessage(output) {
  const headerEnd = output.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1, `missing framed header in: ${output}`);
  const match = /^Content-Length:\s*(\d+)$/im.exec(output.slice(0, headerEnd));
  assert.ok(match, "missing Content-Length");
  const length = Number(match[1]);
  return JSON.parse(output.slice(headerEnd + 4, headerEnd + 4 + length));
}

function runServer(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("mcp-server test timed out")); }, 3000);
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.write(input); child.stdin.end();
  });
}

// ── TOOLS registry ───────────────────────────────────────────────────

describe("TOOLS registry", () => {
  test("registers the expected tool names", () => {
    assert.deepEqual(TOOLS.map((t) => t.name).sort(),
      ["call", "codex_status", "fan_out", "list_providers", "resolve_model"]);
  });

  test("call schema: prompt required, mode enum, options present", () => {
    const tool = TOOLS.find((t) => t.name === "call");
    assert.ok(tool.description.length > 20);
    assert.ok(tool.inputSchema.properties.provider);
    assert.ok(tool.inputSchema.properties.prompt);
    assert.ok(tool.inputSchema.properties.observe, "observe folded in from run_task");
    assert.deepEqual(tool.inputSchema.properties.mode.enum,
      ["task", "review", "agent", "image-generate", "image-edit"]);
    assert.deepEqual(tool.inputSchema.properties.resultMode.enum,
      ["summary", "full", "truncate"]);
    assert.deepEqual(tool.inputSchema.required, ["prompt"]);
  });
});

// ── transport ────────────────────────────────────────────────────────

describe("send / transport", () => {
  test("encodes framed MCP messages", () => {
    const encoded = encodeRpcMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }, "framed");
    assert.match(encoded, /^Content-Length: \d+\r\n\r\n/);
    assert.deepEqual(parseFramedMessage(encoded), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  test("newline-delimited initialize (Claude Code)", async () => {
    const { code, stdout, stderr } = await runServer(`${JSON.stringify(initialize)}\n`);
    assert.equal(code, 0); assert.equal(stderr, "");
    const r = JSON.parse(stdout.trim());
    assert.equal(r.result.serverInfo.name, "fabric");
  });

  test("Content-Length framed initialize (Codex)", async () => {
    const { code, stdout } = await runServer(encodeRpcMessage(initialize, "framed"));
    assert.equal(code, 0);
    assert.equal(parseFramedMessage(stdout).result.serverInfo.name, "fabric");
  });
});

// ── call: validation + dispatch routing ──────────────────────────────

describe("call primitive", () => {
  test("throws on empty / missing prompt", async () => {
    await assert.rejects(() => handleCall({ provider: "claude", prompt: "" }), /prompt must be non-empty/);
    await assert.rejects(() => handleCall({ provider: "claude" }), /prompt must be non-empty/);
  });

  test("throws when provider missing and no sessionDefaults are configured", async () => {
    // Fixture WITHOUT a fabric block → no default provider → the required-error fires.
    await withConfigFixture({ ...ACME_FIXTURE }, () =>
      assert.rejects(() => handleCall({ prompt: "hi" }), /provider is required/));
  });

  test("call falls back to fabric.sessionDefaults for provider/model", async () => {
    await withConfigFixture({ ...ACME_FIXTURE, fabric: { sessionDefaults: { provider: "acme", model: "acme-flash" } } }, () =>
      // The default provider is applied, so the call gets PAST the provider check and
      // fails on the fixture's dead base URL — anything but "provider is required".
      assert.rejects(() => handleCall({ prompt: "hi" }), (e) => !/provider is required/.test(String(e.message))));
  });

  test("rejects image modes for non-codex providers", async () => {
    await assert.rejects(() => handleCall({ provider: "claude", prompt: "x", mode: "image-generate" }),
      (e) => e.kind === "unsupported" && /not supported for provider/.test(e.message));
    // API provider: fixture keeps this hermetic (no host claude_env_settings.json needed).
    await withConfigFixture(ACME_FIXTURE, () =>
      assert.rejects(() => handleCall({ provider: "acme", prompt: "x", mode: "image-generate" }), /not supported for provider/));
  });

  test("review mode is available for non-codex providers (sharp-review regression)", () => {
    assert.equal(typeof API_DISPATCH.review, "function");
    assert.equal(typeof CLAUDE_DISPATCH.review, "function");
    assert.equal(typeof CODEX_DISPATCH.review, "function");
  });

  test("parses provider + mode from <command> block", async () => {
    // Force claude spawn to fail fast so we exercise parse → native dispatch, no real CLI.
    const prev = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = path.join(__dirname, "_no_such_claude.exe");
    try {
      await assert.rejects(() => handleCall({ prompt: "<command>\n--provider claude\n</command>\ndo it" }));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = prev;
    }
  });

  test("observe:true (non-codex) routes to the observe/spawnChild path, not dispatch", async () => {
    let seen = null;
    const fakeSpawnChild = async (opts) => { seen = opts; return { code: 0, stdout: "captured", stderr: "", jsonlPath: null }; };
    const res = await handleCall({ provider: "acme", prompt: "trace me", observe: true }, { spawnChild: fakeSpawnChild });
    assert.equal(seen.observe, true);
    assert.equal(seen.provider, "acme");
    assert.match(text(res), /captured/);
  });
});

// ── fan_out ─────────────────────────────────────────────────────────

describe("fan_out", () => {
  test("requires non-empty tasks array", async () => {
    await assert.rejects(() => handleFanOut({}), /tasks array is required/);
    await assert.rejects(() => handleFanOut({ tasks: [] }), /tasks array is required/);
  });

  test("runs tasks concurrently, returns structured JSON", async () => {
    const res = await handleFanOut({
      tasks: [
        { id: "t1", provider: "acme", prompt: "task one" },
        { id: "t2", provider: "acme", prompt: "task two" },
      ],
      synthesize: false,
    });
    const parsed = JSON.parse(text(res));
    assert.equal(parsed.count, 2);
    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.tasks[0].id, "t1");
    assert.equal(parsed.tasks[1].id, "t2");
  });

  test("captures task failures in structured result", async () => {
    // Success path is hermetic: observe:true routes through the injected spawnChild,
    // so no real provider config or network is needed.
    const fakeSpawnChild = async () => ({ code: 0, stdout: "done", stderr: "", jsonlPath: null });
    const res = await handleFanOut({
      tasks: [
        { provider: "acme", prompt: "ok task", observe: true },
        { provider: "nonexistent", prompt: "bad provider" },
      ],
      synthesize: false,
    }, { spawnChild: fakeSpawnChild });
    const parsed = JSON.parse(text(res));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.tasks[0].ok, true);
    assert.equal(parsed.tasks[1].ok, false);
  });

  test("fan_out tool routes through handleToolCall", async () => {
    const res = await handleToolCall("fan_out", {
      tasks: [{ provider: "acme", prompt: "test" }],
      synthesize: false,
    });
    const parsed = JSON.parse(text(res));
    assert.equal(parsed.count, 1);
  });
});

// ── introspection ────────────────────────────────────────────────────

describe("introspection tools", () => {
  test("list_providers lists claude + codex", async () => {
    const res = await handleToolCall("list_providers", {});
    assert.match(text(res), /claude/);
    assert.match(text(res), /codex/);
  });

  test("unknown tool throws", async () => {
    await assert.rejects(() => handleToolCall("nope", {}), /Tool not found/);
  });
});


// ── every path honours cwd / timeoutMs / model ──────────────────────

describe("call options reach every path", () => {
  const fakeSpawnChild = (sink) => async (opts) => { Object.assign(sink, opts); return { code: 0, stdout: "ok", stderr: "", usage: null }; };

  for (const mode of ["task", "review", "agent"]) {
    test(`claude ${mode}: model, cwd and timeoutMs reach the child`, async () => {
      const seen = {};
      await handleCall({ provider: "claude", mode, model: "opus", prompt: "p", cwd: "C:/work", timeoutMs: 1234, resultMode: "full" },
        { spawnChild: fakeSpawnChild(seen) });
      assert.equal(seen.model, "opus");
      assert.equal(seen.cwd, "C:/work");
      assert.equal(seen.timeoutMs, 1234);
    });
  }

  test("API agent: cwd, timeoutMs and the key task reach the child", async () => {
    const seen = {};
    await withConfigFixture(ACME_FIXTURE, () =>
      handleCall({ provider: "acme", mode: "agent", task: "pr-review", prompt: "p", cwd: "C:/work", timeoutMs: 99, resultMode: "full" },
        { spawnChild: fakeSpawnChild(seen) }));
    assert.equal(seen.cwd, "C:/work");
    assert.equal(seen.timeoutMs, 99);
    assert.equal(seen.task, "pr-review");
  });

  for (const mode of ["task", "review"]) {
    test(`API ${mode}: one ai_lab.call request carrying model, task, images and timeoutMs`, async () => {
      let sent, sentOpts;
      const callAiLab = async (request, o) => { sent = request; sentOpts = o; return { ok: true, result: { text: "from ai-lab" }, usage: { input_tokens: 1, output_tokens: 2 } }; };
      const res = await withConfigFixture(ACME_FIXTURE, () =>
        handleCall({ provider: "acme", mode, model: "opus", task: "pr-review", prompt: "p", timeoutMs: 77, resultMode: "full",
          images: [{ data: "QUJD", media_type: "image/png" }] }, { callAiLab }));
      assert.equal(text(res), "from ai-lab");
      assert.equal(sent.verb, "respond");
      assert.equal(sent.provider, "acme");
      assert.equal(sent.model, "acme-pro", "tier word resolved through the catalogue row, minus Claude Code's [1m]");
      assert.equal(sent.task, "pr-review");
      assert.deepEqual(sent.images, [{ mime: "image/png", data: "QUJD" }]);
      assert.match(sent.context[0].text, /p$/);
      assert.equal(sentOpts.timeoutMs, 77);
    });
  }

  test("planted: no Python -> an API task is unsupported by name; a host agent still runs", async () => {
    const seen = {};
    const prev = process.env.CC_MARKET_CONFIG_PATH;
    process.env.CC_MARKET_CONFIG_PATH = providerCacheFixture({ registry: ACME_FIXTURE, python: path.join(os.tmpdir(), "no-such-venv", "Scripts", "python.exe") }).configPath;
    try {
      await assert.rejects(handleCall({ provider: "acme", prompt: "p", resultMode: "full" }),
        (e) => e.kind === "unsupported" && e.message.includes("ai-lab (not installed) beside") && e.message.includes("no-such-venv") && e.message.includes("node scripts/setup/setup.js"));
      await handleCall({ provider: "claude", mode: "agent", prompt: "p", resultMode: "full" }, { spawnChild: fakeSpawnChild(seen) });
    } finally { process.env.CC_MARKET_CONFIG_PATH = prev; }
    assert.equal(seen.provider, "claude");
  });

  test("API task: an ai-lab kind reaches the caller unchanged", async () => {
    const { ProviderError } = await import("../engine/errors.mjs");
    await withConfigFixture(ACME_FIXTURE, () =>
      assert.rejects(handleCall({ provider: "acme", prompt: "p", resultMode: "full" },
        { callAiLab: async () => { throw new ProviderError("exhausted", "credit"); } }), (e) => e.kind === "exhausted"));
  });

  for (const mode of ["task", "review"]) {
    test(`codex ${mode}: cwd and timeoutMs reach the app-server turn`, async () => {
      const requests = [];
      const handlers = new Map();
      const client = {
        onNotification(m, h) { (handlers.get(m) || handlers.set(m, []).get(m)).push(h); },
        removeNotificationHandler() {},
        clearNotifications() {},
        async send(method, params) {
          requests.push({ method, params });
          if (method === "thread/start") return { thread: { id: "th" } };
          return { turn: { id: "tu" } }; // never completes -> the timeout must fire
        },
      };
      await assert.rejects(
        handleCall({ provider: "codex", mode, prompt: "p", cwd: "C:/work", timeoutMs: 30, resultMode: "full" },
          { withCodexClient: (fn) => fn(client) }),
        (e) => e.kind === "timeout" && /30ms/.test(e.message));
      assert.equal(path.resolve(requests.find((r) => r.method === "thread/start").params.cwd), path.resolve("C:/work"));
    });
  }
});

// ── summariser / synthesiser: configuration, default NONE ───────────

describe("summariser and synthesiser are configuration", () => {
  const LONG = "x".repeat(5000);
  const echoChild = (calls) => async (opts) => { calls.push(opts); return { code: 0, stdout: opts.prompt.includes("Condense") ? "SHORT" : LONG, stderr: "" }; };

  test("no summariser configured: the default result is the full text, no other provider called", async () => {
    const calls = [];
    await withConfigFixture({ providers: {} }, async () => {
      const res = await handleCall({ provider: "claude", prompt: "p" }, { spawnChild: echoChild(calls) });
      assert.equal(text(res), LONG);
    });
    assert.equal(calls.length, 1);
  });

  test("resultMode summary without a configured summariser is refused by name", async () => {
    await withConfigFixture({ providers: {} }, () =>
      assert.rejects(handleCall({ provider: "claude", prompt: "p", resultMode: "summary" }, { spawnChild: echoChild([]) }),
        (e) => e.name === "ConfigError" && /fabric\.summarizer/.test(e.message)));
  });

  test("a configured summariser condenses long output through the call primitive", async () => {
    const calls = [];
    await withConfigFixture({ providers: {}, fabric: { summarizer: { provider: "claude", model: "haiku" } } }, async () => {
      const res = await handleCall({ provider: "claude", prompt: "p" }, { spawnChild: echoChild(calls) });
      assert.match(text(res), /^SHORT/);
      assert.match(text(res), /\[Full: 5000 chars/);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].model, "haiku");
  });

  test("fan_out synthesize without a configured synthesiser is refused by name", async () => {
    await withConfigFixture({ providers: {} }, () =>
      assert.rejects(handleFanOut({ tasks: [{ provider: "claude", prompt: "p" }], synthesize: true }, { spawnChild: echoChild([]) }),
        (e) => e.name === "ConfigError" && /fabric\.synthesizer/.test(e.message)));
  });

  test("fan_out does not synthesise by default", async () => {
    const calls = [];
    await withConfigFixture({ providers: {} }, async () => {
      const parsed = JSON.parse(text(await handleFanOut({ tasks: [{ provider: "claude", prompt: "p" }] }, { spawnChild: echoChild(calls) })));
      assert.equal(parsed.synthesis, undefined);
      assert.equal(parsed.tasks[0].result.length, 400);
    });
    assert.equal(calls.length, 1);
  });

  test("a configured synthesiser runs once over the task results", async () => {
    const calls = [];
    await withConfigFixture({ providers: {}, fabric: { synthesizer: { provider: "claude", model: "sonnet" } } }, async () => {
      const parsed = JSON.parse(text(await handleFanOut({ tasks: [{ id: "a", provider: "claude", prompt: "p" }], synthesize: true }, { spawnChild: echoChild(calls) })));
      assert.ok(parsed.synthesis);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].model, "sonnet");
  });
});

// ── fan_out concurrency limit ───────────────────────────────────────

describe("fan_out concurrency", () => {
  const tracking = (stats) => async () => {
    stats.now++; stats.max = Math.max(stats.max, stats.now);
    await new Promise((r) => setTimeout(r, 20));
    stats.now--;
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, provider: "claude", prompt: "p" }));

  test("fabric.fanOutConcurrency bounds the calls in flight, results keep task order", async () => {
    const stats = { now: 0, max: 0 };
    await withConfigFixture({ providers: {}, fabric: { fanOutConcurrency: 2 } }, async () => {
      const parsed = JSON.parse(text(await handleFanOut({ tasks }, { spawnChild: tracking(stats) })));
      assert.deepEqual(parsed.tasks.map((t) => t.id), tasks.map((t) => t.id));
      assert.equal(parsed.ok, true);
    });
    assert.equal(stats.max, 2);
  });

  test("the default limit is FAN_OUT_CONCURRENCY_DEFAULT", async () => {
    const stats = { now: 0, max: 0 };
    const many = Array.from({ length: FAN_OUT_CONCURRENCY_DEFAULT + 3 }, (_, i) => ({ id: `t${i}`, provider: "claude", prompt: "p" }));
    await withConfigFixture({ providers: {} }, () => handleFanOut({ tasks: many }, { spawnChild: tracking(stats) }));
    assert.equal(stats.max, FAN_OUT_CONCURRENCY_DEFAULT);
  });

  test("a non-positive-integer limit is refused by name", async () => {
    for (const bad of [0, -1, 1.5, "4"]) {
      await withConfigFixture({ providers: {}, fabric: { fanOutConcurrency: bad } }, () =>
        assert.rejects(handleFanOut({ tasks }, { spawnChild: tracking({ now: 0, max: 0 }) }),
          (e) => e.name === "ConfigError" && /fabric\.fanOutConcurrency/.test(e.message)));
    }
  });
});
