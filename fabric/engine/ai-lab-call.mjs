// engine/ai-lab-call.mjs — every one-shot API call goes through `python -m ai_lab.call`.
//
// fabric holds no vendor HTTP, no key and no retry loop: it spawns the interpreter the provider
// cache recorded (setup pins it), writes one JSON request on stdin and reads one JSON reply on
// stdout (ai-lab's versioned protocol, CALL_SCHEMA_VERSION 2). A classified provider failure is
// a reply with `ok:false` and a `kind`, mapped onto ProviderError; exit 2 is a malformed request.
// A missing interpreter or a missing ai-lab is `unsupported`, naming which. Usage is recorded
// once per call in ai-lab's ledger (`--ledger`), the one usage record; fabric writes none.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "../shared/spawn.mjs";
import { ProviderError, ERROR_KINDS } from "./errors.mjs";
import { killTree, treeSpawnOptions } from "./kill-tree.mjs";
import { readCatalogue, getConfigPath, cachePathFor, SETUP_REMEDY } from "./providers.mjs";
import { loadFabricConfig } from "./fabric-config.mjs";

export const CALL_SCHEMA_VERSION = 2;
const EXIT_MALFORMED = 2;

/** The interpreter the provider cache pinned; unsupported by name when absent. */
export function aiLabPython(configPath = getConfigPath()) {
  const python = readCatalogue(configPath).python;
  if (!python) {
    throw new ProviderError("unsupported", `provider cache ${cachePathFor(configPath)} records no Python interpreter; run \`${SETUP_REMEDY}\``);
  }
  if (!fs.existsSync(python)) {
    throw new ProviderError("unsupported", `Python ${python} (recorded in ${cachePathFor(configPath)}) is not installed; run \`${SETUP_REMEDY}\``);
  }
  return python;
}

/** The ledger every call is recorded in: `fabric.ledger`, else ~/.claude/fabric/ledger.jsonl. */
export function ledgerPath(configPath = getConfigPath()) {
  return loadFabricConfig(configPath).ledger || path.join(os.homedir(), ".claude", "fabric", "ledger.jsonl");
}

/** A reply's `kind` as a ProviderError kind: '' (unclassified) is `failed`. */
export function replyKind(kind) {
  return kind && ERROR_KINDS.includes(kind) ? kind : "failed";
}

/**
 * Send one request to `ai_lab.call`; resolves the reply of a successful call, rejects with a
 * ProviderError otherwise. `timeoutMs` kills the whole process tree (kind `timeout`).
 */
export function callAiLab(request, { configPath = getConfigPath(), ledger = ledgerPath(configPath), timeoutMs = 600000, signal = null,
  _spawn = spawn, _python = null, _killTree = killTree } = {}) {
  const python = _python || aiLabPython(configPath);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const args = ["-m", "ai_lab.call", "--ledger", ledger];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("ai_lab.call: request cancelled")); return; }
    const child = _spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: process.env, ...treeSpawnOptions() });
    let stdout = "", stderr = "", settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(v);
    };
    const onAbort = () => { try { _killTree(child); } catch {} settle(reject, new Error("ai_lab.call: request cancelled")); };
    const timer = setTimeout(() => {
      try { _killTree(child); } catch {}
      settle(reject, new ProviderError("timeout", `ai_lab.call ${request.provider}:${request.model}: no reply after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => settle(reject, e.code === "ENOENT"
      ? new ProviderError("unsupported", `Python ${python} cannot be started (${e.message}); run \`${SETUP_REMEDY}\``)
      : e));
    child.on("close", (code) => {
      if (code === EXIT_MALFORMED) { settle(reject, new ProviderError("failed", `ai_lab.call refused the request: ${stderr.trim()}`)); return; }
      if (code !== 0) {
        if (/No module named '?ai_lab/.test(stderr)) {
          settle(reject, new ProviderError("unsupported", `ai-lab is not installed in ${python}; run \`${SETUP_REMEDY}\``));
        } else {
          settle(reject, new ProviderError("failed", `ai_lab.call exited ${code}: ${stderr.trim().slice(-500)}`));
        }
        return;
      }
      let reply;
      try { reply = JSON.parse(stdout); } catch { settle(reject, new ProviderError("failed", `ai_lab.call wrote no JSON reply: ${stdout.slice(0, 200)}`)); return; }
      if (reply.schema_version !== CALL_SCHEMA_VERSION) {
        settle(reject, new ProviderError("failed", `ai_lab.call replied with schema_version ${reply.schema_version}, expected ${CALL_SCHEMA_VERSION}`));
        return;
      }
      if (!reply.ok) { settle(reject, new ProviderError(replyKind(reply.kind), reply.error || "ai_lab.call failed")); return; }
      settle(resolve, reply);
    });
    child.stdin.on("error", () => {}); // a child that died early: its close event reports it
    child.stdin.end(JSON.stringify(request));
  });
}

/** The response schema of a free-text one-shot call. */
export const TEXT_SCHEMA = Object.freeze({
  type: "object",
  properties: { text: { type: "string", description: "The complete answer." } },
  required: ["text"],
  additionalProperties: false,
});

/**
 * A free-text `respond` request: instructions, the prompt as text context, images as base64.
 */
export function textRequest({ provider, model, task, instructions = "", prompt, images = [] }) {
  return {
    verb: "respond", provider, model, ...(task ? { task } : {}),
    instructions, context: [{ kind: "text", text: prompt }], schema: TEXT_SCHEMA,
    ...(images.length ? { images: images.map((i) => ({ mime: i.media_type || "image/png", data: i.data })) } : {}),
  };
}
