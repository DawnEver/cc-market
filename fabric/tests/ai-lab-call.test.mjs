// Tests for engine/ai-lab-call.mjs — the one-shot path is `python -m ai_lab.call`. A real child
// process (fixtures/fake-ai-lab-call.mjs under node) stands in for the interpreter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../shared/spawn.mjs";
import { callAiLab, aiLabPython, replyKind, textRequest, TEXT_SCHEMA } from "../engine/ai-lab-call.mjs";
import { providerCacheFixture } from "./fixtures/provider-cache.mjs";

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
  assert.deepEqual(seen.args, ["-m", "ai_lab.call"]);
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
  await assert.rejects(callAiLab(req("v2"), opts()), (e) => e.kind === "failed" && /schema_version 2/.test(e.message));
});

test("timeoutMs kills the child and is kind timeout", async () => {
  const killed = [];
  await assert.rejects(callAiLab(req("hang"), opts({ timeoutMs: 300, _killTree: (c) => { killed.push(c.pid); c.kill("SIGKILL"); } })),
    (e) => e.kind === "timeout" && /300ms/.test(e.message));
  assert.equal(killed.length, 1);
});

test("the interpreter is the one the provider cache pinned", () => {
  const { configPath } = providerCacheFixture({ python: process.execPath });
  assert.equal(aiLabPython(configPath), process.execPath);
});
