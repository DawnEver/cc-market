#!/usr/bin/env node
// fabric MCP server — the "MCP" half of the dual-form fabric (the other half is the
// importable shared/ library). Hand-rolled JSON-RPC over stdio (line + framed transport).
//
// One call primitive, exposed as a small honest surface:
//   - call           : invoke a model, one-shot. `mode` (task/review/agent/image-*) carries
//                      policy; provider/model/write/observe/images are options. Subsumes what
//                      were once takeover's `call_model` and fabric's `run_task` — "one task"
//                      is one call; "many" is the caller making N calls (fan-out is the
//                      orchestrator's job, not a tool's).
//   - fan_out        : N calls in parallel, compact JSON + optional synthesis.
//   - list_providers / resolve_model / codex_status : introspection.
//
// Layering: L0 mechanism = engine/ (providers, spawn-child, ai-lab-call, codex,
// observe). L1 policy = scripts/lib + scripts/codex + prompts (modes, prompt
// shaping, <command> parsing, result shaping). L2 ergonomics = commands/
// skills/agents. This file wires L1 onto L0.

import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  extractText,
  truncateText,
  listModels,
  parseCommandBlock,
  callCodexCompanion,
  spawnClaudeP,
  checkCodexStatus,
  ConfigError,
  ProviderError,
} from "./lib.mjs";
import { withPooledClient, poolStats } from "../engine/codex/app-server.mjs";
import { resolveModelFromId, getConfigPath } from "../engine/providers.mjs";
import { loadFabricConfig } from "../engine/fabric-config.mjs";
import { spawnChild } from "../engine/spawn-child.mjs";
import { callAiLab, textRequest } from "../engine/ai-lab-call.mjs";
import { summarizeFile } from "../engine/observe-reader.mjs";
import { createStdioServer, encodeRpcMessage } from "../engine/mcp-rpc.mjs";
import { isMain } from "../shared/lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

const textResult = (s) => ({ content: [{ type: "text", text: s }] });

// ── Tool definitions ──────────────────────────────────────────────

export const TOOLS = [
  {
    name: "call",
    description: "Invoke a model. <command> block flags in prompt override params.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "claude, codex, deepseek, or key from claude_env_settings.json" },
        model: { type: "string", description: "Model override" },
        task: { type: "string", description: "Key task of an API provider (its credential: api-key-<task>). Default: default" },
        mode: {
          type: "string",
          enum: ["task", "review", "agent", "image-generate", "image-edit"],
          description: "task|review|agent|image-*. Default: task",
        },
        write: { type: "boolean", description: "Allow file writes (codex only)" },
        systemPrompt: { type: "string", description: "System prompt override" },
        prompt: { type: "string", description: "Message or task to send" },
        images: {
          type: "array",
          description: "Base64 images with media type",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              data: { type: "string", description: "Base64 data" },
              media_type: { type: "string", description: "MIME type" },
            },
          },
        },
        observe: { type: "boolean", description: "Capture HTTP traffic to jsonl (non-codex)" },
        cwd: { type: "string", description: "Working dir" },
        timeoutMs: { type: "number", description: "Kill after N ms" },
        resultMode: {
          type: "string",
          enum: ["summary", "full", "truncate"],
          description: "summary (needs fabric.summarizer)|full|truncate. Default: summary if a summarizer is configured, else full",
        },
        maxResultChars: { type: "number", description: "Cap when truncate. 0=unlimited" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_providers",
    description: "List configured providers and model aliases.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resolve_model",
    description: "Remap a Claude model id to a provider's upstream model id.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider key" },
        model: { type: "string", description: "Claude model id" },
      },
      required: ["provider", "model"],
    },
  },
  {
    name: "codex_status",
    description: "Check Codex CLI install and auth status.",
    inputSchema: {
      type: "object",
      properties: { codexPath: { type: "string", description: "Path to codex binary" } },
    },
  },
  {
    name: "fan_out",
    description: "Run N tasks in parallel (at most fabric.fanOutConcurrency at once, default 4), return compact JSON (each result capped at 400 chars). Optional synthesis.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Task label" },
              provider: { type: "string" },
              prompt: { type: "string" },
              mode: { type: "string", enum: ["task", "review", "agent"] },
              write: { type: "boolean" },
              model: { type: "string" },
              task: { type: "string", description: "Key task" },
              cwd: { type: "string", description: "Working dir" },
              timeoutMs: { type: "number", description: "Kill after N ms" },
            },
            required: ["provider", "prompt"],
          },
        },
        synthesize: { type: "boolean", description: "Synthesize results via the configured fabric.synthesizer (refused if none). Default false" },
      },
      required: ["tasks"],
    },
  },
];

// ── Image helpers ──────────────────────────────────────────────────

const EXT_TO_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const MAX_DATA_URI_BYTES = 150000;

function resolveImages(images) {
  if (!images || !images.length) return [];
  const resolved = [];
  for (const img of images) {
    if (img.data) {
      resolved.push(img);
    } else if (img.path) {
      try {
        const raw = readFileSync(img.path);
        const ext = (img.path.match(/\.\w+$/i) || [".png"])[0].toLowerCase();
        resolved.push({ path: img.path, data: raw.toString("base64"), media_type: img.media_type || EXT_TO_MIME[ext] || "image/png" });
      } catch (e) {
        process.stderr.write(`fabric-mcp: failed to read image ${img.path}: ${e.message}\n`);
      }
    }
  }
  return resolved;
}

function checkImageSizeLimit(resolvedImages, provider, providerConfig) {
  if (provider === "codex" || !providerConfig.native) return; // API providers: ai-lab sends structured images
  const oversized = resolvedImages.filter((img) => img.data.length > MAX_DATA_URI_BYTES);
  if (oversized.length > 0) {
    const sizes = oversized.map((img) => `${img.path || "image"} (${(img.data.length / 1024).toFixed(0)}KB)`).join(", ");
    throw new ConfigError(
      `Image(s) too large for text-prompt embedding: ${sizes}. Max ${MAX_DATA_URI_BYTES / 1000}KB per image. ` +
      `Options: (1) pre-resize, (2) use an API provider that supports structured content blocks, (3) use provider=codex.`
    );
  }
}


// ── Result shaping: keep parent context clean ─────────────────────

// Summariser and synthesiser are CONFIGURATION (fabric.summarizer / fabric.synthesizer,
// each {provider, model?}), default NONE: fabric never picks a provider on its own. Both run
// through the one call primitive, so they follow the same routing as any other call.
const SUMMARIZE_PROMPT = "Condense the following into a tight summary for a parent orchestrator. Keep: key findings, decisions, file changes, errors, next steps. Drop: narration, greetings, markdown fluff, play-by-play. 3-5 sentences max.";
const SYNTHESIZE_PROMPT = "Synthesize these N parallel task results into a 2-3 sentence summary for the orchestrator. Flag failures, patterns, and follow-ups.";
const SUMMARY_THRESHOLD = 2000;

function configuredHelper(key, asked) {
  const helper = loadFabricConfig()[key];
  if (helper?.provider) return helper;
  throw new ConfigError(`${asked} needs a configured fabric.${key} ({provider, model?} in the fabric block of claude_env_settings.json); none is set`);
}

async function runHelper(helper, instruction, body, deps) {
  const res = await handleCall({ provider: helper.provider, model: helper.model, prompt: `${instruction}\n\n${body}`, resultMode: "full" }, deps);
  return res.content[0].text;
}

async function summarizeOutput(fullText, deps) {
  const helper = configuredHelper("summarizer", 'resultMode "summary"');
  if (!fullText || fullText.length <= SUMMARY_THRESHOLD) return fullText;
  try {
    return (await runHelper(helper, SUMMARIZE_PROMPT, fullText, deps)) + `\n\n[Full: ${fullText.length} chars → resultMode:"full"]`;
  } catch (e) {
    // The work itself succeeded; never lose it to a failed summary.
    return `${fullText}\n\n[summary by ${helper.provider} failed: ${e.message}]`;
  }
}

// ── Provider dispatch (policy: mode × provider) ────────────────────

async function dispatchCodexTask({ userPrompt, systemPrompt, model, write, resolvedImages, cwd, timeoutMs, withCodexClient }) {
  const hasImages = resolvedImages.length > 0;
  process.stderr.write(`fabric-mcp: calling codex (${model || "default"})${write ? " [write]" : ""}${hasImages ? ` + ${resolvedImages.length} image(s)` : ""}...\n`);
  const data = await withCodexClient((client) => callCodexCompanion(userPrompt, {
    systemPrompt, model: model || null, write: !!write, images: hasImages ? resolvedImages : null, client, cwd, timeoutMs,
  }));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexAgent({ userPrompt, systemPrompt, model, write, resolvedImages, cwd, timeoutMs, withCodexClient }) {
  process.stderr.write(`fabric-mcp: agent mode — provider=codex model=${model || "(none)"}\n`);
  const data = await withCodexClient((client) => callCodexCompanion(userPrompt, {
    systemPrompt, model: model || null, write: !!write, images: resolvedImages.length > 0 ? resolvedImages : null, client, cwd, timeoutMs,
  }));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexReview({ userPrompt, model, imageURIs, cwd, timeoutMs, withCodexClient }) {
  process.stderr.write(`fabric-mcp: codex review (adversarial)...\n`);
  const promptWithImages = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
  const { runCodexReview } = await import("./codex/review.mjs");
  const data = await withCodexClient((client) => runCodexReview(promptWithImages, { model: model || null, cwd, client, timeoutMs }));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexImageGenerate({ userPrompt, cwd, timeoutMs, withCodexClient }) {
  process.stderr.write(`fabric-mcp: codex image generate (app-server)...\n`);
  const { generateImage } = await import("./codex/image.mjs");
  const data = await withCodexClient((client) => generateImage(userPrompt, { client, cwd, timeout: timeoutMs }));
  return { data, resolvedModel: "codex-image-gen" };
}

async function dispatchCodexImageEdit({ userPrompt, systemPrompt, cwd, timeoutMs, withCodexClient }) {
  process.stderr.write(`fabric-mcp: codex image edit (app-server)...\n`);
  const { handleImageEdit } = await import("./codex/image.mjs");
  const data = await withCodexClient((client) => handleImageEdit(userPrompt, systemPrompt, { client, cwd, timeout: timeoutMs }));
  return { data, resolvedModel: "codex-image-edit" };
}

const CODEX_DISPATCH = {
  task: dispatchCodexTask,
  agent: dispatchCodexAgent,
  review: dispatchCodexReview,
  "image-generate": dispatchCodexImageGenerate,
  "image-edit": dispatchCodexImageEdit,
};

// The child options every claude -p path forwards: model, key task, cwd, timeoutMs, signal.
const childOpts = ({ systemPrompt, model, task, resolvedImages, signal, cwd, timeoutMs, spawnChild: _spawnChild }) => ({
  systemPrompt, model: model || null, task, images: resolvedImages.length > 0 ? resolvedImages : null, signal, cwd, timeoutMs, _spawnChild,
});

async function dispatchClaudeTask(ctx) {
  process.stderr.write(`fabric-mcp: calling claude (native CLI, model=${ctx.model || "default"})...\n`);
  const data = await spawnClaudeP(ctx.userPrompt, childOpts(ctx));
  return { data, resolvedModel: ctx.model || "claude" };
}

async function dispatchClaudeAgent(ctx) {
  process.stderr.write(`fabric-mcp: agent mode — provider=${ctx.provider} model=${ctx.model || "(none)"}\n`);
  const data = await spawnClaudeP(ctx.userPrompt, { provider: ctx.provider, ...childOpts(ctx) });
  return { data, resolvedModel: ctx.model || "claude" };
}

const CLAUDE_DISPATCH = {
  task: dispatchClaudeTask,
  agent: dispatchClaudeAgent,
  // Non-codex providers have no dedicated adversarial-review endpoint; review runs as a task
  // with the review system prompt (built from mode in handleCall).
  review: dispatchClaudeTask,
};

// A one-shot API call is one `ai_lab.call` request: ai-lab holds the wire, the key (by task)
// and the retries. cwd has no meaning for it (no filesystem); timeoutMs bounds the whole call
// and surfaces as kind `timeout`.
async function dispatchAPITask({ userPrompt, systemPrompt, provider, providerConfig, model, task, resolvedImages, timeoutMs, callAiLab: _callAiLab = callAiLab }) {
  const resolvedModel = resolveModel(providerConfig, model || null);
  if (!resolvedModel) throw new ConfigError(`provider "${provider}" declares no default model; pass model`);
  process.stderr.write(`fabric-mcp: calling ${provider}:${resolvedModel} (ai_lab.call)...\n`);
  // Platform prompt for API providers: the same fabric.systemPromptFile the claude-CLI paths inject.
  const sysFile = loadFabricConfig(getConfigPath()).systemPromptFile;
  const platform = sysFile && existsSync(sysFile) ? readFileSync(sysFile, "utf8") : "";
  const instructions = [platform, systemPrompt].filter(Boolean).join("\n\n");
  const reply = await _callAiLab(textRequest({ provider, model: resolvedModel, task, instructions, prompt: userPrompt, images: resolvedImages }),
    { timeoutMs: timeoutMs || undefined });
  return { data: { content: [{ type: "text", text: reply.result?.text ?? "" }], usage: reply.usage }, resolvedModel };
}

async function dispatchAPIAgent(ctx) {
  process.stderr.write(`fabric-mcp: agent mode — provider=${ctx.provider} model=${ctx.model || "(none)"}\n`);
  const data = await spawnClaudeP(ctx.userPrompt, { provider: ctx.provider, ...childOpts(ctx) });
  return { data, resolvedModel: ctx.model || ctx.provider };
}

const API_DISPATCH = {
  task: dispatchAPITask,
  agent: dispatchAPIAgent,
  review: dispatchAPITask,
};

export { API_DISPATCH, CLAUDE_DISPATCH, CODEX_DISPATCH };

// observe path: capture a non-codex child's API traffic. Debug modifier orthogonal to mode —
// forces the isolated-config harness engine (fabric's spawnChild) behind the observe proxy.
async function runObserved(args, _spawnChild) {
  const runDir = args.runDir || join(tmpdir(), `fabric-call-${Date.now()}`);
  const res = await _spawnChild({
    provider: args.provider, prompt: args.prompt, model: args.model,
    observe: true, passthroughAuth: args.passthroughAuth, task: args.task, runDir, cwd: args.cwd, timeoutMs: args.timeoutMs,
  });
  const parts = [res.stdout?.trim() || "(no output)"];
  if (res.jsonlPath) parts.push("", `--- observe capture: ${res.jsonlPath} ---`, JSON.stringify(summarizeFile(res.jsonlPath)));
  if (res.code !== 0) parts.push("", `(exit code ${res.code})`, res.stderr?.trim() || "");
  return textResult(parts.join("\n"));
}

// ── The one call primitive ────────────────────────────────────────

export async function handleCall(args, deps = {}) {
  let { provider, model, mode, systemPrompt: customSystem, prompt: userPrompt, write, images, observe } = args;

  // <command> block flags are authoritative.
  const parsed = parseCommandBlock(userPrompt);
  if (parsed.flags.provider) provider = parsed.flags.provider;
  if (parsed.flags.model) model = parsed.flags.model;
  if (parsed.flags.mode) mode = parsed.flags.mode;
  userPrompt = parsed.cleanPrompt;
  if (parsed.flags.write && write === undefined) write = true;

  // A provider omitted everywhere falls back to fabric.sessionDefaults — an explicit <command> flag still wins above.
  if (!provider) {
    const sd = loadFabricConfig().sessionDefaults || {};
    provider = sd.provider || null;
    if (!model) model = sd.model || null;
  }
  if (!provider) throw new ConfigError("provider is required — pass it directly, include --provider <name> in a <command> block, or set fabric.sessionDefaults.provider in claude_env_settings.json");
  if (!userPrompt || !userPrompt.trim()) throw new ConfigError("prompt must be non-empty");

  // observe is a debug modifier: capture raw traffic via the harness engine (non-codex only).
  if (observe && provider !== "codex") {
    return runObserved({ ...args, provider, prompt: userPrompt, model }, deps.spawnChild || spawnChild);
  }

  // Instruction layering (systematic, all providers identical):
  //   system layer  = platform prompt (fabric.systemPromptFile / codex
  //                  model_instructions_file / API provider systemPromptFile)
  //   per-call layer = mode template (mode-specific instructions ONLY — the
  //                  platform/GLOBAL layers own universal principles, so
  //                  prompts/*.md must not restate them; the overlap guard
  //                  test enforces this) + customSystem (explicit override) +
  //                  the user prompt, all as user messages.
  let systemPrompt = customSystem || "";
  const modeInstruction = (!customSystem && mode) ? buildPrompt(mode, userPrompt).systemPrompt : "";
  if (modeInstruction) userPrompt = `${modeInstruction}\n\n${userPrompt}`;

  const resolvedImages = resolveImages(images);
  const imageURIs = resolvedImages.length > 0
    ? resolvedImages.map((img) => `data:${img.media_type};base64,${img.data}`).join("\n") : "";

  const providerConfig = loadProviderConfig(provider);
  checkImageSizeLimit(resolvedImages, provider, providerConfig);

  const effectiveMode = mode || "task";
  const common = {
    userPrompt, systemPrompt, provider, model, task: args.task, resolvedImages, cwd: args.cwd, timeoutMs: args.timeoutMs,
    spawnChild: deps.spawnChild, withCodexClient: deps.withCodexClient || withPooledClient,
  };
  let dispatchMap, dispatchContext;
  if (providerConfig.provider === "codex") {
    dispatchMap = CODEX_DISPATCH;
    dispatchContext = { ...common, write, imageURIs };
  } else if (providerConfig.native) {
    dispatchMap = CLAUDE_DISPATCH;
    dispatchContext = common;
  } else {
    dispatchMap = API_DISPATCH;
    dispatchContext = { ...common, providerConfig, callAiLab: deps.callAiLab };
  }

  const handler = dispatchMap[effectiveMode];
  if (!handler) {
    throw new ProviderError("unsupported",
      `Mode "${effectiveMode}" is not supported for provider "${provider}". Supported modes: ${Object.keys(dispatchMap).join(", ")}.`
    );
  }

  // Usage is recorded once, by ai-lab's ledger (API calls); fabric keeps no trace of its own.
  const { data } = await handler(dispatchContext);
  const fullText = extractText(data);
  const resultMode = args.resultMode || (loadFabricConfig().summarizer?.provider ? "summary" : "full");
  let resultText;
  if (resultMode === "full") {
    resultText = fullText;
  } else if (resultMode === "truncate") {
    resultText = truncateText(fullText, args.maxResultChars ?? 2000);
  } else {
    resultText = await summarizeOutput(fullText, deps);
  }
  return { content: [{ type: "text", text: resultText }] };
}

// ── fan_out: the orchestrator's parallel-work primitive ─────────

// Calls in flight at once: fabric.fanOutConcurrency, else this default. Each call may be a
// whole claude/codex process, so an unbounded fan-out of N tasks is N processes at once.
export const FAN_OUT_CONCURRENCY_DEFAULT = 4;

function fanOutConcurrency() {
  const v = loadFabricConfig().fanOutConcurrency;
  if (v === undefined) return FAN_OUT_CONCURRENCY_DEFAULT;
  if (Number.isInteger(v) && v >= 1) return v;
  throw new ConfigError(`fabric.fanOutConcurrency must be a positive integer, got ${JSON.stringify(v)}`);
}

// Run fn over items with at most `limit` in flight; results in item order.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function handleFanOut(args, deps) {
  const { tasks, synthesize = false } = args;
  if (!tasks || !tasks.length) throw new ConfigError("fan_out: tasks array is required and must be non-empty");
  const synthesizer = synthesize ? configuredHelper("synthesizer", "fan_out synthesize") : null;
  const limit = fanOutConcurrency();

  const results = await mapLimited(tasks, limit, async (task, i) => {
      const id = task.id || `task-${i}`;
      const t0 = Date.now();
      try {
        const res = await handleCall({
          provider: task.provider,
          prompt: task.prompt,
          mode: task.mode || "task",
          write: !!task.write,
          model: task.model,
          task: task.task,
          observe: task.observe,
          cwd: task.cwd,
          timeoutMs: task.timeoutMs,
        }, deps);
        const text = res.content[0].text;
        const fullMatch = text.match(/\[Full: (\d+) chars/);
        const result = fullMatch
          ? text.slice(0, text.lastIndexOf("\n\n[Full:")).trim()
          : text;
        return {
          id, ok: true,
          result: result.length > 400 ? result.slice(0, 397) + "..." : result,
          estTokens: { in: Math.round((fullMatch ? parseInt(fullMatch[1]) : text.length) / 4), out: Math.round(text.length / 4) },
          durationMs: Date.now() - t0,
        };
      } catch (e) {
        return { id, ok: false, ...(e.kind ? { kind: e.kind } : {}), error: e.message.slice(0, 200), durationMs: Date.now() - t0 };
      }
  });

  let synthesis = null;
  if (synthesizer) {
    const summaryText = results.map((r) => `[${r.id}] ${r.ok ? r.result : `FAILED: ${r.error}`}`).join("\n");
    try {
      synthesis = await runHelper(synthesizer, SYNTHESIZE_PROMPT, summaryText, deps);
    } catch (e) {
      synthesis = `(synthesis by ${synthesizer.provider} failed: ${e.message})`;
    }
  }

  const allOk = results.every((r) => r.ok);
  const totalEstTokens = results.reduce((s, r) => s + (r.estTokens?.in || 0) + (r.estTokens?.out || 0), 0);

  return textResult(JSON.stringify({
    ok: allOk,
    count: results.length,
    failed: results.filter((r) => !r.ok).length,
    tasks: results,
    totalEstTokens,
    ...(synthesis ? { synthesis } : {}),
  }));
}

// ── Tool dispatch ─────────────────────────────────────────────────

export async function handleToolCall(name, args = {}, deps = {}) {
  switch (name) {
    case "call":
      return await handleCall(args, deps);
    case "fan_out":
      return await handleFanOut(args, deps);
    case "list_providers":
      return textResult(listModels());
    case "resolve_model": {
      const cfg = loadProviderConfig(args.provider);
      if (cfg.native) return textResult(`${args.provider} is native — no model remapping.`);
      return textResult(resolveModelFromId(cfg, args.model));
    }
    case "codex_status": {
      const status = checkCodexStatus(args.codexPath || null);
      // Pool saturation is a fact the caller needs to read a slow codex call correctly:
      // waiters > 0 means calls are QUEUED, not running (SR-054).
      const pool = poolStats();
      const lines = [
        `Installed: ${status.installed}`,
        status.path ? `Path: ${status.path}` : "",
        status.version ? `Version: ${status.version}` : "",
        `Authenticated: ${status.authenticated}`,
        `Pool: ${pool.total}/${pool.size} clients (${pool.idle} idle, ${pool.waiters} waiting)${pool.saturated ? " — SATURATED" : ""}`,
        status.error ? `Error: ${status.error}` : "",
      ];
      return textResult(lines.filter(Boolean).join("\n"));
    }
    default:
      throw new Error(`Tool not found: ${name}`);
  }
}

// ── Transport (shared JSON-RPC stdio) ─────────────────────────────

const rpc = createStdioServer({
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  tools: TOOLS,
  handleToolCall,
  label: "fabric-mcp",
});
// Re-exported for tests + backward-compatible import sites.
export const send = rpc.send;
export const handleRpcRequest = rpc.handleRpcRequest;
export { encodeRpcMessage };

if (isMain(import.meta.url)) {
  rpc.main().catch((error) => {
    process.stderr.write(`fabric-mcp fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
