// Tests for Antigravity CLI (`agy`) discovery and `spawnAgyP` runner.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  findAgyBinary,
  findAgyBinaryAsync,
  checkAgyStatus,
  checkAgyStatusAsync,
  parseAgyModels,
} from "../engine/agy/discovery.mjs";
import {
  spawnAgyP,
  parseAgyOutput,
  buildAgyEnv,
  classifyAgyError,
  AGY_STDIN_THRESHOLD,
} from "../scripts/lib/agy.mjs";
import { handleFanOut } from "../scripts/mcp-server.mjs";

function makeFakeChild({ stdout = "", stderr = "", code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.pid = 42424;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let stdinBuf = "";
  let emitted = false;
  const emitFinish = () => {
    if (emitted) return;
    emitted = true;
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.exitCode = code;
    child.emit("close", code);
  };
  child.stdin = {
    write(chunk) { stdinBuf += String(chunk); child._stdin = stdinBuf; return true; },
    end() {
      child._stdin = stdinBuf;
      queueMicrotask(emitFinish);
    },
  };
  queueMicrotask(emitFinish);
  return child;
}

describe("agy discovery", () => {
  test("parseAgyModels parses tab-separated model id and display name", () => {
    const out = parseAgyModels("gemini-4-neon-high\tGemini 4 Neon (High)\nclaude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\n");
    assert.deepEqual(out, [
      { id: "gemini-4-neon-high", displayName: "Gemini 4 Neon (High)" },
      { id: "claude-sonnet-5-5-high", displayName: "Claude Sonnet 5.5 (High)" },
    ]);
  });

  test("findAgyBinary honors AGY_CLI_PATH override and rejects missing path", async () => {
    const orig = process.env.AGY_CLI_PATH;
    process.env.AGY_CLI_PATH = process.execPath;
    try {
      assert.equal(findAgyBinary(), process.execPath);
      assert.equal(await findAgyBinaryAsync(), process.execPath);
    } finally {
      if (orig !== undefined) process.env.AGY_CLI_PATH = orig;
      else delete process.env.AGY_CLI_PATH;
    }

    const missingBin = process.platform === "win32" ? "C:\\__no_such_dir__\\agy.exe" : "/__no_such_dir__/agy";
    assert.throws(() => findAgyBinary(missingBin), /AGY_CLI_PATH not found/);
    await assert.rejects(() => findAgyBinaryAsync(missingBin), /AGY_CLI_PATH not found/);
  });

  test("checkAgyStatus and checkAgyStatusAsync report installed=false on missing binary", async () => {
    const missingBin = process.platform === "win32" ? "C:\\__no_such_dir__\\agy.exe" : "/__no_such_dir__/agy";
    const syncRes = checkAgyStatus(missingBin);
    assert.equal(syncRes.installed, false);
    assert.equal(syncRes.authenticated, false);
    assert.ok(syncRes.error);

    const asyncRes = await checkAgyStatusAsync(missingBin);
    assert.equal(asyncRes.installed, false);
    assert.equal(asyncRes.authenticated, false);
    assert.ok(asyncRes.error);
  });
});

describe("buildAgyEnv & classifyAgyError", () => {
  test("strips third-party ANTHROPIC_* provider vars and sets smoke/print flags", () => {
    const env = buildAgyEnv({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      ANTHROPIC_API_KEY: "sk-leak",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "fake-sonnet",
      CLAUDE_CODE_SESSION_ID: "cc-123",
      CODEX_THREAD_ID: "cx-456",
    });
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.CC_CONFIG_AGY_SMOKE, "1");
    assert.equal(env.CC_CONFIG_AGY_PRINT, "1");
    assert.equal(env.PATH, "/usr/bin");
  });

  test("classifies auth, quota, rate_limit, timeout, unsupported, and generic errors", () => {
    assert.equal(classifyAgyError("[Auth Error] not authenticated"), "auth");
    assert.equal(classifyAgyError("Quota exhausted for model"), "exhausted");
    assert.equal(classifyAgyError("429 Too Many Requests"), "rate_limit");
    assert.equal(classifyAgyError("request timed out"), "timeout");
    assert.equal(classifyAgyError("Invalid model tier bogus"), "unsupported");
    assert.equal(classifyAgyError("unexpected internal crash"), "failed");
  });
});

describe("parseAgyOutput", () => {
  test("parses single JSON object from --output-format json", () => {
    const raw = JSON.stringify({
      conversation_id: "conv-1",
      status: "SUCCESS",
      response: "PONG\n",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const parsed = parseAgyOutput(raw, false);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.response, "PONG\n");
    assert.equal(parsed.result.conversation_id, "conv-1");
  });

  test("parses NDJSON events from --output-format stream-json", () => {
    const ndjson = [
      JSON.stringify({ event: "init", conversation_id: "conv-2" }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "HELLO_" } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "WORLD" } }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-2", status: "SUCCESS", response: "HELLO_WORLD\n", usage: { total_tokens: 25 } },
      }),
    ].join("\n");
    const parsed = parseAgyOutput(ndjson, true);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.response, "HELLO_WORLD\n");
    assert.equal(parsed.result.conversation_id, "conv-2");
  });
});

describe("spawnAgyP", () => {
  test("short single-line read-only prompt uses --output-format json and --mode plan --sandbox", async () => {
    let seenArgs, seenOpts;
    const fakeSpawn = (bin, args, opts) => {
      seenArgs = args;
      seenOpts = opts;
      return makeFakeChild({
        stdout: JSON.stringify({
          conversation_id: "c-short",
          status: "SUCCESS",
          response: "PONG\n",
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        }),
      });
    };
    const res = await spawnAgyP("reply PONG", {
      _bin: "/fake/agy",
      _spawn: fakeSpawn,
      model: "gemini-4-carbon-low",
      cwd: "C:/repo",
    });
    assert.deepEqual(res.content, [{ type: "text", text: "PONG" }]);
    assert.equal(res.conversation_id, "c-short");
    assert.equal(res.usage.total_tokens, 105);
    assert.deepEqual(seenArgs, [
      "--output-format", "json",
      "--model", "gemini-4-carbon-low",
      "--mode", "plan",
      "--sandbox",
      "-p", "reply PONG",
    ]);
    assert.equal(seenOpts.cwd, "C:/repo");
    assert.equal(seenOpts.windowsHide, true);
    assert.equal(seenOpts.stdio[0], "ignore");
  });

  test("write:true uses --dangerously-skip-permissions", async () => {
    let seenArgs;
    const fakeSpawn = (_bin, args) => {
      seenArgs = args;
      return makeFakeChild({
        stdout: JSON.stringify({ conversation_id: "c-write", status: "SUCCESS", response: "DONE" }),
      });
    };
    const res = await spawnAgyP("apply patch", { _bin: "/fake/agy", _spawn: fakeSpawn, write: true });
    assert.equal(res.content[0].text, "DONE");
    assert.ok(seenArgs.includes("--dangerously-skip-permissions"));
    assert.ok(!seenArgs.includes("--mode"));
  });

  test("multi-line or >4KB prompt uses stream-json stdin to avoid Windows 32KB argv limit", async () => {
    let seenArgs, childRef;
    const streamed = [];
    const longPrompt = "Line 1\n" + "x".repeat(AGY_STDIN_THRESHOLD + 20);
    const fakeSpawn = (_bin, args) => {
      seenArgs = args;
      childRef = makeFakeChild({
        stdout: [
          JSON.stringify({ event: "init", conversation_id: "c-stream" }),
          JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "CHUNK_1" } }),
          JSON.stringify({ event: "result", result: { conversation_id: "c-stream", status: "SUCCESS", response: "CHUNK_1_FINAL" } }),
        ].join("\n") + "\n",
      });
      return childRef;
    };
    const res = await spawnAgyP(longPrompt, {
      _bin: "/fake/agy",
      _spawn: fakeSpawn,
      systemPrompt: "Be concise.",
      onText: (t) => streamed.push(t),
    });
    assert.equal(res.content[0].text, "CHUNK_1_FINAL");
    assert.deepEqual(streamed, ["CHUNK_1"]);
    assert.deepEqual(seenArgs.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
    assert.deepEqual(seenArgs.slice(-2), ["-p", ""]);
    const stdinMsg = JSON.parse(childRef._stdin.trim());
    assert.equal(stdinMsg.event, "user");
    assert.equal(stdinMsg.message.role, "user");
    assert.equal(stdinMsg.message.content.startsWith("[System instructions]\nBe concise.\n\nLine 1\n"), true);
    assert.equal(stdinMsg.message.content.length > AGY_STDIN_THRESHOLD, true);
  });

  test("ERROR JSON status surfaces as classified ProviderError", async () => {
    const fakeSpawn = () => makeFakeChild({
      code: 1,
      stdout: JSON.stringify({
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: "[Auth Error] Failed to select license: not authenticated",
      }),
    });
    await assert.rejects(
      () => spawnAgyP("hello", { _bin: "/fake/agy", _spawn: fakeSpawn }),
      (e) => e.name === "ProviderError" && e.kind === "auth" && /not authenticated/.test(e.message),
    );
  });

  test("timeout kills child tree and rejects with ProviderError(timeout)", async () => {
    let killed = false;
    const child = new EventEmitter();
    child.pid = 42424;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const fakeSpawn = () => child;
    await assert.rejects(
      () => spawnAgyP("hang", {
        _bin: "/fake/agy",
        _spawn: fakeSpawn,
        _killTree: () => { killed = true; },
        timeoutMs: 25,
      }),
      (e) => e.name === "ProviderError" && e.kind === "timeout" && /25ms/.test(e.message),
    );
    assert.equal(killed, true);
  });

  test("fan_out executes parallel agy tasks cleanly", async () => {
    const prev = process.env.CC_MARKET_CONFIG_PATH;
    process.env.CC_MARKET_CONFIG_PATH = "/nonexistent/hermetic-config.json";
    try {
      const res = await handleFanOut({
        tasks: [
          { id: "a1", provider: "agy", prompt: "review file A", mode: "review" },
          { id: "a2", provider: "agy", prompt: "fix file B", mode: "task", write: true },
        ],
      }, {
        spawnAgy: async (prompt, opts) => ({
          content: [{ type: "text", text: `${opts.write ? "WROTE" : "READ"}:${prompt.slice(-6)}` }],
        }),
      });
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.count, 2);
      assert.equal(parsed.tasks[0].result, "READ:file A");
      assert.equal(parsed.tasks[1].result, "WROTE:file B");
    } finally {
      if (prev !== undefined) process.env.CC_MARKET_CONFIG_PATH = prev;
      else delete process.env.CC_MARKET_CONFIG_PATH;
    }
  });
});
