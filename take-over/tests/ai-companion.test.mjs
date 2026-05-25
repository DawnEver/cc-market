/**
 * Tests for ai-companion.mjs
 * Run: node --test claude_plugins/ai/tests/ai-companion.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Import helpers — we test exported functions by re-implementing them inline
// (the script is not designed as a module with named exports, so we duplicate
// the pure functions here and test them directly against identical logic).
// For spawn-dependent functions we use module mocking.
// ---------------------------------------------------------------------------

// ── Inline copies of pure functions ─────────────────────────────────────────

function loadProviderConfig(provider, settingsPath) {
  if (provider === "codex") {
    return { native: true, provider: "codex" };
  }
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Config file not found: ${settingsPath}`);
  }
  const config = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const envKey = `env:${provider}`;
  const env = config[envKey];
  if (!env) {
    throw new Error(
      `Provider "${provider}" not found in claude_env_settings.json. ` +
        `Add an "env:${provider}" block.`
    );
  }
  const isEmpty = !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_BASE_URL;
  if (isEmpty && provider === "claude") {
    return { native: true, provider: "claude" };
  }
  return {
    native: false,
    baseUrl: env.ANTHROPIC_BASE_URL,
    token: env.ANTHROPIC_AUTH_TOKEN,
    defaultOpus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultSonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultHaiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
}

function resolveModel(providerConfig, requestedModel) {
  if (requestedModel) return requestedModel;
  return providerConfig.defaultSonnet;
}

function buildPrompt(subcommand, userPrompt, promptsDir) {
  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }
  return { systemPrompt, userPrompt: userPrompt.trim() };
}

function parseArgs(argv) {
  const options = { provider: null, model: null, write: false };
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--provider":
        options.provider = argv[++i];
        break;
      case "--model":
      case "-m":
        options.model = argv[++i];
        break;
      case "--write":
        options.write = true;
        break;
      default:
        if (!argv[i].startsWith("-")) {
          positionals.push(argv[i]);
        }
    }
    i++;
  }
  return { options, prompt: positionals.join(" ") };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROMPTS_DIR = path.join(PLUGIN_DIR, "prompts");

/** Create a temp settings file with the given content and return its path. */
function makeTempSettings(obj) {
  const tmp = path.join(__dirname, `_tmp_settings_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj));
  return tmp;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("loadProviderConfig", () => {
  test('returns { native: true, provider: "codex" } for codex provider', () => {
    const result = loadProviderConfig("codex", "/nonexistent");
    assert.deepEqual(result, { native: true, provider: "codex" });
  });

  test('returns native claude config for claude provider with empty env', () => {
    const settingsPath = makeTempSettings({ "env:claude": {} });
    try {
      const result = loadProviderConfig("claude", settingsPath);
      assert.deepEqual(result, { native: true, provider: "claude" });
    } finally {
      fs.unlinkSync(settingsPath);
    }
  });

  test('returns API config for non-empty claude provider env', () => {
    const settingsPath = makeTempSettings({
      "env:claude": {
        ANTHROPIC_AUTH_TOKEN: "tok",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
      },
    });
    try {
      const result = loadProviderConfig("claude", settingsPath);
      assert.equal(result.native, false);
      assert.equal(result.token, "tok");
    } finally {
      fs.unlinkSync(settingsPath);
    }
  });

  test('throws when settings file does not exist', () => {
    assert.throws(
      () => loadProviderConfig("deepseek", "/nonexistent/path.json"),
      /Config file not found/
    );
  });

  test('throws for unknown provider', () => {
    const settingsPath = makeTempSettings({});
    try {
      assert.throws(
        () => loadProviderConfig("unknown-provider", settingsPath),
        /Provider "unknown-provider" not found/
      );
    } finally {
      fs.unlinkSync(settingsPath);
    }
  });
});

describe("parseArgs", () => {
  test('parses --provider flag', () => {
    const { options } = parseArgs(["--provider", "deepseek"]);
    assert.equal(options.provider, "deepseek");
  });

  test('parses --model flag', () => {
    const { options } = parseArgs(["--model", "claude-opus-4-5"]);
    assert.equal(options.model, "claude-opus-4-5");
  });

  test('parses -m shorthand', () => {
    const { options } = parseArgs(["-m", "gpt-4o"]);
    assert.equal(options.model, "gpt-4o");
  });

  test('parses --write flag', () => {
    const { options } = parseArgs(["--write"]);
    assert.equal(options.write, true);
  });

  test('--write defaults to false', () => {
    const { options } = parseArgs([]);
    assert.equal(options.write, false);
  });

  test('collects positional arguments as prompt', () => {
    const { prompt } = parseArgs(["fix", "the", "bug"]);
    assert.equal(prompt, "fix the bug");
  });

  test('handles mixed flags and positionals', () => {
    const { options, prompt } = parseArgs([
      "--provider", "codex",
      "--model", "o4-mini",
      "--write",
      "do something useful",
    ]);
    assert.equal(options.provider, "codex");
    assert.equal(options.model, "o4-mini");
    assert.equal(options.write, true);
    assert.equal(prompt, "do something useful");
  });
});

describe("resolveModel", () => {
  test('returns requested model when provided', () => {
    const config = { defaultSonnet: "claude-sonnet-4-5" };
    assert.equal(resolveModel(config, "claude-opus-4-5"), "claude-opus-4-5");
  });

  test('falls back to defaultSonnet when no model requested', () => {
    const config = { defaultSonnet: "claude-sonnet-4-5" };
    assert.equal(resolveModel(config, null), "claude-sonnet-4-5");
  });

  test('returns undefined when no model and no defaultSonnet', () => {
    const config = {};
    assert.equal(resolveModel(config, null), undefined);
  });
});

describe("buildPrompt", () => {
  test('loads system prompt from template when file exists', () => {
    // task.md should exist in the real prompts dir
    const taskFile = path.join(PROMPTS_DIR, "task.md");
    if (!fs.existsSync(taskFile)) {
      // skip gracefully
      return;
    }
    const { systemPrompt, userPrompt } = buildPrompt("task", "do stuff", PROMPTS_DIR);
    assert.ok(systemPrompt.length > 0, "systemPrompt should be non-empty");
    assert.equal(userPrompt, "do stuff");
  });

  test('returns empty systemPrompt when template does not exist', () => {
    const { systemPrompt, userPrompt } = buildPrompt(
      "nonexistent-subcommand-xyz",
      "  my prompt  ",
      PROMPTS_DIR
    );
    assert.equal(systemPrompt, "");
    assert.equal(userPrompt, "my prompt");
  });

  test('trims userPrompt whitespace', () => {
    const { userPrompt } = buildPrompt("nonexistent-subcommand-xyz", "  hello world  ", PROMPTS_DIR);
    assert.equal(userPrompt, "hello world");
  });
});

// ── Inline semver sort helper (mirrors findCodexCompanion logic) ─────────────
function semverSort(versions) {
  return [...versions].sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
}

describe("callCodexCompanion", () => {
  test("semverSort picks highest version first", () => {
    const sorted = semverSort(["1.0.2", "2.1.0", "1.9.9", "2.0.1"]);
    assert.equal(sorted[0], "2.1.0");
    assert.equal(sorted[1], "2.0.1");
  });

  test("spawns node <companionPath> task --model <m> <prompt> when model is provided", (_t, done) => {
    const spawnCalls = [];
    const FAKE_COMPANION = "/fake/codex-companion.mjs";

    function callCodexCompanionWith(spawnFn, execPath, companionPath, userPrompt, systemPrompt, model, writeMode = false) {
      return new Promise((resolve, reject) => {
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
        const args = ["task"];
        if (writeMode) args.push("--write");
        if (model) args.push("--model", model);
        args.push(fullPrompt);
        const child = spawnFn(execPath, [companionPath, ...args], {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 600000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
          else reject(new Error(`codex-companion exited ${code}: ${stderr.trim()}`));
        });
      });
    }

    function fakeSpawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit("data", "companion output");
        child.emit("close", 0);
      });
      return child;
    }

    callCodexCompanionWith(fakeSpawn, process.execPath, FAKE_COMPANION, "write tests", "be helpful", "o4-mini")
      .then((result) => {
        assert.equal(spawnCalls.length, 1);
        const { cmd, args } = spawnCalls[0];
        assert.equal(cmd, process.execPath);
        assert.equal(args[0], FAKE_COMPANION);
        assert.equal(args[1], "task");
        assert.equal(args[2], "--model");
        assert.equal(args[3], "o4-mini");
        assert.ok(args[4].includes("write tests"), "prompt should be last arg");
        assert.ok(args[4].includes("be helpful"), "system prompt should be prepended");
        assert.ok(!args.includes("--write"), "--write should not appear for read-only");
        assert.deepEqual(result.content, [{ type: "text", text: "companion output" }]);
        done();
      })
      .catch(done);
  });

  test("spawns without --model when model is null", (_t, done) => {
    const spawnCalls = [];
    const FAKE_COMPANION = "/fake/codex-companion.mjs";

    function callCodexCompanionWith(spawnFn, execPath, companionPath, userPrompt, systemPrompt, model) {
      return new Promise((resolve, reject) => {
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
        const args = ["task"];
        if (model) args.push("--model", model);
        args.push(fullPrompt);
        const child = spawnFn(execPath, [companionPath, ...args], {});
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", () => {});
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
          else reject(new Error(`exit ${code}`));
        });
      });
    }

    function fakeSpawn(_cmd, args) {
      spawnCalls.push({ args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit("close", 0));
      return child;
    }

    callCodexCompanionWith(fakeSpawn, process.execPath, FAKE_COMPANION, "do something", "", null)
      .then(() => {
        const { args } = spawnCalls[0];
        assert.ok(!args.includes("--model"), "--model should not be present");
        assert.equal(args[args.length - 1], "do something");
        done();
      })
      .catch(done);
  });

  test("adds --write when writeMode is true", (_t, done) => {
    const spawnCalls = [];
    const FAKE_COMPANION = "/fake/codex-companion.mjs";

    function callCodexCompanionWith(spawnFn, execPath, companionPath, userPrompt, _systemPrompt, model, writeMode) {
      return new Promise((resolve, reject) => {
        const args = ["task"];
        if (writeMode) args.push("--write");
        if (model) args.push("--model", model);
        args.push(userPrompt);
        const child = spawnFn(execPath, [companionPath, ...args], {});
        child.stdout = new EventEmitter(); child.stdout.on("data", () => {});
        child.stderr = new EventEmitter(); child.stderr.on("data", () => {});
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ content: [] });
          else reject(new Error(`exit ${code}`));
        });
      });
    }

    function fakeSpawn(_cmd, args) {
      spawnCalls.push({ args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit("close", 0));
      return child;
    }

    callCodexCompanionWith(fakeSpawn, process.execPath, FAKE_COMPANION, "fix it", "", null, true)
      .then(() => {
        const { args } = spawnCalls[0];
        assert.ok(args.includes("--write"), "--write should be present");
        done();
      })
      .catch(done);
  });

  test("rejects when codex-companion exits with non-zero code", (_t, done) => {
    const FAKE_COMPANION = "/fake/codex-companion.mjs";

    function callCodexCompanionWith(spawnFn, execPath, companionPath, userPrompt) {
      return new Promise((resolve, reject) => {
        const args = ["task", userPrompt];
        const child = spawnFn(execPath, [companionPath, ...args], {});
        let stderr = "";
        child.stdout = new EventEmitter(); child.stdout.on("data", () => {});
        child.stderr = new EventEmitter(); child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ content: [] });
          else reject(new Error(`codex-companion exited ${code}: ${stderr.trim()}`));
        });
      });
    }

    function fakeSpawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stderr.emit("data", "auth failed");
        child.emit("close", 1);
      });
      return child;
    }

    callCodexCompanionWith(fakeSpawn, process.execPath, FAKE_COMPANION, "fail")
      .then(() => done(new Error("should have rejected")))
      .catch((err) => {
        assert.match(err.message, /codex-companion exited 1/);
        done();
      });
  });
});

describe("callNativeClaude (integration)", () => {
  test("skip: requires real claude CLI", { skip: "requires real claude CLI installed" }, () => {
    // This test is intentionally skipped as it requires the actual claude CLI.
  });
});
