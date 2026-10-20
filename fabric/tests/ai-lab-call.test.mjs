// Tests for engine/ai-lab-call.mjs — the one-shot path is `python -m ai_lab.call`. A real child
// process (fixtures/fake-ai-lab-call.mjs under node) stands in for the interpreter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../shared/spawn.mjs";
import { callAiLab, aiLabPython, ledgerPath, replyKind, textRequest, TEXT_SCHEMA } from "../engine/ai-lab-call.mjs";
import { providerCacheFixture } from "./fixtures/provider-cache.mjs";

// Hermetic: the registry (and so the ledger path) is a temp fixture.
const FIXTURE = providerCacheFixture();
process.env.CC_MARKET_CONFIG_PATH = FIXTURE.configPath;

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ai-lab-call.mjs");
// Run the fake under node whatever interpreter path the caller resolved; argv is kept so it is recorded.
const fakeSpawn = (seen = {}) => (cmd, args, opts) => { seen.cmd = cmd; seen.args = args; return spawn(process.execPath, [FAKE, ...args], opts); };
const req = (provider, extra = {}) => textRequest({ provider, model: "m1", prompt: "hello", ...extra });
const opts = (extra = {}) => ({ _python: "python-fixture", _spawn: fakeSpawn(), ...extra });

test("a successful reply resolves with its result and usage, through -m ai_lab.call", async () => {
  const seen = {};
  const reply = await callAiLab(req("acme"), opts({ _spawn: fakeSpawn(seen) }));
  assert.equal(reply.result.text, "echo: hello");
  assert.equal(reply.usage.output_tokens, 5);
  assert.equal(seen.cmd, "python-fixture");
  assert.deepEqual(seen.args, ["-m", "ai_lab.call", "--ledger", path.join(FIXTURE.dir, "ledger.jsonl")]);
});

test("usage goes to the ledger fabric.ledger names, else ~/.claude/fabric/ledger.jsonl", () => {
  assert.equal(ledgerPath(FIXTURE.configPath), path.join(FIXTURE.dir, "ledger.jsonl"));
  const bare = providerCacheFixture({ registry: { fabric: { ledger: null } } });
  assert.equal(ledgerPath(bare.configPath), path.join(os.homedir(), ".claude", "fabric", "ledger.jsonl"));
});

test("textRequest is a respond request with the text schema and base64 images", () => {
  const r = textRequest({ provider: "acme", model: "m1", task: "pr-review", instructions: "be brief", prompt: "p",
    images: [{ media_type: "image/jpeg", data: "QUJD" }] });
  assert.deepEqual(r, { verb: "respond", provider: "acme", model: "m1", task: "pr-review", instructions: "be brief",
    context: [{ kind: "text", text: "p" }], schema: TEXT_SCHEMA, images: [{ mime: "image/jpeg", data: "QUJD" }] });
  assert.equal("task" in textRequest({ provider: "a", model: "m", prompt: "p" }), false);
});

for (const kind of ["exhausted", "auth", "rate_limit", "unsupported", "timeout"]) {
  test(`a reply of kind ${kind} is a ProviderError of kind ${kind}`, async () => {
    await assert.rejects(callAiLab(req(`kind-${kind}`), opts()), (e) => e.kind === kind && e.message.includes(`classified ${kind}`));
  });
}

test("an unclassified failure (kind '') is kind failed", async () => {
  assert.equal(replyKind(""), "failed");
  await assert.rejects(callAiLab(req("unclassified"), opts()), (e) => e.kind === "failed" && /the vendor said no/.test(e.message));
});

test("a malformed request (exit 2) is failed with ai-lab's reason", async () => {
  await assert.rejects(callAiLab(req("malformed"), opts()), (e) => e.kind === "failed" && /missing field/.test(e.message));
});

test("another protocol version is refused", async () => {
  await assert.rejects(callAiLab(req("v1"), opts()), (e) => e.kind === "failed" && /schema_version 1/.test(e.message));
});

test("timeoutMs kills the child and is kind timeout", async () => {
  const killed = [];
  await assert.rejects(callAiLab(req("hang"), opts({ timeoutMs: 300, _killTree: (c) => { killed.push(c.pid); c.kill("SIGKILL"); } })),
    (e) => e.kind === "timeout" && /300ms/.test(e.message));
  assert.equal(killed.length, 1);
});

test("the interpreter is the one the provider cache pinned", () => {
  const { configPath, dir } = providerCacheFixture();
  assert.equal(aiLabPython(configPath), path.join(dir, "venv", "Scripts", "python.exe"));
});

// ── planted refusals: a one-shot call without Python or ai-lab is unsupported BY NAME ──

test("planted: the cache's Python is not installed -> unsupported naming it and the remedy", () => {
  const { configPath } = providerCacheFixture({ python: path.join(FIXTURE.dir, "no-such-python.exe") });
  assert.throws(() => aiLabPython(configPath),
    (e) => e.kind === "unsupported" && e.message.includes("no-such-python.exe") && e.message.includes("ai-lab (not installed)") && /setup/.test(e.message));
});

test("planted: a cache recording no Python -> unsupported naming it", () => {
  const { configPath } = providerCacheFixture({ python: null });
  assert.throws(() => aiLabPython(configPath), (e) => e.kind === "unsupported" && /is missing python/.test(e.message));
});

test("planted: the interpreter cannot be started -> unsupported naming it", async () => {
  const enoent = () => { const c = spawn(process.execPath, ["-e", ""], {}); setImmediate(() => c.emit("error", Object.assign(new Error("spawn py ENOENT"), { code: "ENOENT" }))); return c; };
  await assert.rejects(callAiLab(req("acme"), { _python: "py-missing", _spawn: enoent }),
    (e) => e.kind === "unsupported" && /Python py-missing cannot be started/.test(e.message));
});

test("planted: ai-lab is not installed in the interpreter -> unsupported naming ai-lab", async () => {
  await assert.rejects(callAiLab(req("nomodule"), opts()),
    (e) => e.kind === "unsupported" && /ai-lab is not installed in python-fixture/.test(e.message));
});
