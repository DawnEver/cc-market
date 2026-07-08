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
//   - spawn_session / session_send / session_close / list_sessions : PERSISTENT multi-turn
//                      sessions. This long-lived stdio server IS the handle-holding daemon —
//                      it holds live session handles in an in-process registry
//                      (shared/session.mjs) across discrete tool calls. codex + claude + API.
//   - list_providers / resolve_model / codex_status : introspection.
//
// Layering: L0 mechanism = shared/ engines (providers, spawn-child, anthropic-http, codex,
// session, observe). L1 policy = scripts/lib + scripts/codex + prompts (modes, prompt
// shaping, <command> parsing, result/usage shaping, traceme). L2 ergonomics = commands/
// skills/agents. This file wires L1 onto L0.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  extractText,
  listModels,
  parseCommandBlock,
  callAnthropicAPI,
  callCodexCompanion,
  spawnClaudeP,
  emitProviderTrace,
  checkCodexStatus,
  logProviderRequest,
  ConfigError,
  ProviderError,
} from "./lib.mjs";
import { withSharedClient } from "../shared/codex/app-server.mjs";
import { resolveModelFromId } from "../shared/providers.mjs";
import { spawnChild } from "../shared/spawn-child.mjs";
import { summarizeFile } from "../shared/observe-reader.mjs";
import { createSession, sendToSession, closeSession, listSessions } from "../shared/session.mjs";
import { createStdioServer, encodeRpcMessage } from "../shared/mcp-rpc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

const textResult = (s) => ({ content: [{ type: "text", text: s }] });

// ── Tool definitions ──────────────────────────────────────────────

export const TOOLS = [
  {
    name: "call",
    description:
      "Invoke a model from any configured provider — one-shot. The atomic orchestration " +
      "primitive: 'one task' is one call; run several concurrently for fan-out. " +
      "Routes to Claude (native CLI), Codex (app-server), or any Anthropic-compatible API " +
      "from ~/.claude/claude_env_settings.json. `mode` selects policy (task/review/agent/" +
      "image-*). If `prompt` contains a <command> block with --provider/--model/--review/" +
      "--image/--image-edit/--write flags, those are parsed authoritatively and override the " +
      "params. For persistent multi-turn instead, use spawn_session.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider: claude, codex, deepseek, or a custom key from claude_env_settings.json. Optional if a <command> block sets --provider." },
        model: { type: "string", description: "Model name. Optional — uses provider default." },
        mode: {
          type: "string",
          enum: ["task", "review", "agent", "image-generate", "image-edit"],
          description:
            "Operation mode (default 'task'). 'task' = code/investigation (API providers run " +
            "raw completion, no harness). 'review' = adversarial code review (codex uses its " +
            "native review endpoint; others run it as a task with the review system prompt). " +
            "'agent' = full tool-access via the Claude Code harness + provider env. " +
            "'image-generate' / 'image-edit' = codex only.",
        },
        write: { type: "boolean", description: "codex only: enable tools so the model can edit files / run commands. Ignored for other providers." },
        systemPrompt: { type: "string", description: "Custom system prompt. Overrides `mode`'s system prompt if both set." },
        prompt: { type: "string", description: "The user message or task to hand off." },
        images: {
          type: "array",
          description: "Optional image attachments. Each is base64-encoded with a media type.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Original file path (for reference)" },
              data: { type: "string", description: "Base64-encoded image data" },
              media_type: { type: "string", description: "MIME type, e.g. image/png" },
            },
          },
        },
        observe: { type: "boolean", description: "Non-codex: route the child through the observe proxy and capture API traffic to runDir/http.jsonl (debug). Forces the harness engine." },
        passthroughAuth: { type: "boolean", description: "observe only: proxy forwards the child's own Authorization header instead of injecting a static key. Defaults on for native claude." },
        cwd: { type: "string", description: "Working dir for the child. Defaults to the server cwd." },
        runDir: { type: "string", description: "observe only: isolated dir for config + capture. Defaults to a temp dir." },
        timeoutMs: { type: "number", description: "observe only: kill the child after this many ms." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "spawn_session",
    description: "Open a PERSISTENT multi-turn child session and return its id. Unlike `call` (one-shot, stateless), the session stays alive across calls and retains context between turns. Drive it with session_send, then session_close when done. codex uses a native app-server thread; claude/API use a long-lived stream-json child.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: 'Provider key: "codex", "claude", "deepseek", …' },
        model: { type: "string", description: "Model id. Optional — uses provider default." },
        write: { type: "boolean", description: "codex only: enable tools so the session can act (git, edit files). Default false." },
        cwd: { type: "string", description: "Working dir for the session. Defaults to the server cwd." },
        observe: { type: "boolean", description: "Non-codex: route through the observe proxy + capture jsonl. Default false." },
      },
      required: ["provider"],
    },
  },
  {
    name: "session_send",
    description: "Send one turn to a persistent session (from spawn_session) and return its reply. Context from earlier turns is retained. Turns are serialized per session — await each before the next.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session id returned by spawn_session." },
        prompt: { type: "string", description: "The turn text to send." },
      },
      required: ["id", "prompt"],
    },
  },
  {
    name: "session_close",
    description: "Close a persistent session and free its child process. Always close sessions you spawn.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Session id returned by spawn_session." } },
      required: ["id"],
    },
  },
  {
    name: "list_sessions",
    description: "List the currently open persistent sessions held by this server (id, provider, turn count).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_providers",
    description: "List all configured providers (claude/codex + any Anthropic-compatible API from claude_env_settings.json) and their model aliases.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resolve_model",
    description: 'Resolve a full Claude model id (e.g. "claude-haiku-4-5-...") to a provider\'s real upstream model id, using the provider\'s tier aliases.',
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: 'Provider key, e.g. "deepseek".' },
        model: { type: "string", description: "Full Claude model id to remap." },
      },
      required: ["provider", "model"],
    },
  },
  {
    name: "codex_status",
    description: "Check Codex CLI installation status, version, and authentication state.",
    inputSchema: {
      type: "object",
      properties: { codexPath: { type: "string", description: "Optional path to codex binary. Auto-detected if omitted." } },
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
  if (provider === "codex" || providerConfig.baseUrl) return;
  const oversized = resolvedImages.filter((img) => img.data.length > MAX_DATA_URI_BYTES);
  if (oversized.length > 0) {
    const sizes = oversized.map((img) => `${img.path || "image"} (${(img.data.length / 1024).toFixed(0)}KB)`).join(", ");
    throw new ConfigError(
      `Image(s) too large for text-prompt embedding: ${sizes}. Max ${MAX_DATA_URI_BYTES / 1000}KB per image. ` +
      `Options: (1) pre-resize, (2) use an API provider that supports structured content blocks, (3) use provider=codex.`
    );
  }
}

function emitTrace(data, provider, resolvedModel, mode) {
  const usage = data?._usage || data?.usage || null;
  emitProviderTrace({
    ts: new Date().toISOString(),
    provider, model: resolvedModel || "default", mode: mode || "task",
    input_tokens: usage?.input_tokens || 0, output_tokens: usage?.output_tokens || 0,
    cache_read: usage?.cache_read_input_tokens || 0, cache_write: usage?.cache_creation_input_tokens || 0,
  });
}

// ── Provider dispatch (policy: mode × provider) ────────────────────

async function dispatchCodexTask({ userPrompt, systemPrompt, model, write, resolvedImages }) {
  const hasImages = resolvedImages.length > 0;
  process.stderr.write(`fabric-mcp: calling codex (${model || "default"})${write ? " [write]" : ""}${hasImages ? ` + ${resolvedImages.length} image(s)` : ""}...\n`);
  const data = await withSharedClient((client) =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, hasImages ? resolvedImages : null, client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexAgent({ userPrompt, systemPrompt, model, write, resolvedImages }) {
  process.stderr.write(`fabric-mcp: agent mode — provider=codex model=${model || "(none)"}\n`);
  const data = await withSharedClient((client) =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, resolvedImages.length > 0 ? resolvedImages : null, client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexReview({ userPrompt, model, imageURIs }) {
  process.stderr.write(`fabric-mcp: codex review (adversarial)...\n`);
  const promptWithImages = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
  const { runCodexReview } = await import("./codex/review.mjs");
  const data = await withSharedClient((client) => runCodexReview(promptWithImages, model || null, null, process.cwd(), client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexImageGenerate({ userPrompt }) {
  process.stderr.write(`fabric-mcp: codex image generate (app-server)...\n`);
  const { generateImage } = await import("./codex/image.mjs");
  const data = await withSharedClient((client) => generateImage(userPrompt, { client }));
  return { data, resolvedModel: "codex-image-gen" };
}

async function dispatchCodexImageEdit({ userPrompt, systemPrompt }) {
  process.stderr.write(`fabric-mcp: codex image edit (app-server)...\n`);
  const { handleImageEdit } = await import("./codex/image.mjs");
  const data = await withSharedClient((client) => handleImageEdit(userPrompt, systemPrompt, { client }));
  return { data, resolvedModel: "codex-image-edit" };
}

const CODEX_DISPATCH = {
  task: dispatchCodexTask,
  agent: dispatchCodexAgent,
  review: dispatchCodexReview,
  "image-generate": dispatchCodexImageGenerate,
  "image-edit": dispatchCodexImageEdit,
};

async function dispatchClaudeTask({ userPrompt, systemPrompt, resolvedImages, signal }) {
  process.stderr.write("fabric-mcp: calling claude (native CLI)...\n");
  const data = await spawnClaudeP(userPrompt, { systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: "claude" };
}

async function dispatchClaudeAgent({ userPrompt, systemPrompt, provider, model, resolvedImages, signal }) {
  process.stderr.write(`fabric-mcp: agent mode — provider=${provider} model=${model || "(none)"}\n`);
  const data = await spawnClaudeP(userPrompt, { provider, model: model || null, systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: model || "claude" };
}

const CLAUDE_DISPATCH = {
  task: dispatchClaudeTask,
  agent: dispatchClaudeAgent,
  // Non-codex providers have no dedicated adversarial-review endpoint; review runs as a task
  // with the review system prompt (built from mode in handleCall).
  review: dispatchClaudeTask,
};

async function dispatchAPITask({ userPrompt, systemPrompt, providerConfig, model, signal }) {
  const resolvedModel = resolveModel(providerConfig, model || null);
  process.stderr.write(`fabric-mcp: calling ${resolvedModel} (API)...\n`);
  const data = await callAnthropicAPI(providerConfig, resolvedModel, systemPrompt, userPrompt, null, true, signal);
  return { data, resolvedModel };
}

async function dispatchAPIAgent({ userPrompt, systemPrompt, provider, model, resolvedImages, signal }) {
  process.stderr.write(`fabric-mcp: agent mode — provider=${provider} model=${model || "(none)"}\n`);
  const data = await spawnClaudeP(userPrompt, { provider, model: model || null, systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: model || provider };
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
    observe: true, passthroughAuth: args.passthroughAuth, runDir, cwd: args.cwd, timeoutMs: args.timeoutMs,
  });
  const parts = [res.stdout?.trim() || "(no output)"];
  if (res.jsonlPath) parts.push("", `--- observe capture: ${res.jsonlPath} ---`, JSON.stringify(summarizeFile(res.jsonlPath)));
  if (res.code !== 0) parts.push("", `(exit code ${res.code})`, res.stderr?.trim() || "");
  return textResult(parts.join("\n"));
}

// ── The one call primitive ────────────────────────────────────────

export async function handleCall(args, deps = {}) {
  let { provider, model, mode, systemPrompt: customSystem, prompt: userPrompt, write, images, observe } = args;
  const startTs = new Date().toISOString();

  // <command> block flags are authoritative.
  const parsed = parseCommandBlock(userPrompt);
  if (parsed.flags.provider) provider = parsed.flags.provider;
  if (parsed.flags.model) model = parsed.flags.model;
  if (parsed.flags.mode) mode = parsed.flags.mode;
  userPrompt = parsed.cleanPrompt;
  if (parsed.flags.write && write === undefined) write = true;

  if (!provider) throw new ConfigError("provider is required — pass it directly or include --provider <name> in a <command> block in prompt");
  if (!userPrompt || !userPrompt.trim()) throw new ConfigError("prompt must be non-empty");

  // observe is a debug modifier: capture raw traffic via the harness engine (non-codex only).
  if (observe && provider !== "codex") {
    return runObserved({ ...args, provider, prompt: userPrompt, model }, deps.spawnChild || spawnChild);
  }

  let systemPrompt = customSystem || "";
  if (!customSystem && mode) systemPrompt = buildPrompt(mode, userPrompt).systemPrompt;

  const resolvedImages = resolveImages(images);
  const imageURIs = resolvedImages.length > 0
    ? resolvedImages.map((img) => `data:${img.media_type};base64,${img.data}`).join("\n") : "";

  const providerConfig = loadProviderConfig(provider);
  checkImageSizeLimit(resolvedImages, provider, providerConfig);

  const effectiveMode = mode || "task";
  let dispatchMap, dispatchContext;
  if (providerConfig.provider === "codex") {
    dispatchMap = CODEX_DISPATCH;
    dispatchContext = { userPrompt, systemPrompt, provider, model, write, resolvedImages, imageURIs };
  } else if (providerConfig.native) {
    dispatchMap = CLAUDE_DISPATCH;
    dispatchContext = { userPrompt, systemPrompt, provider, model, resolvedImages };
  } else {
    dispatchMap = API_DISPATCH;
    dispatchContext = { userPrompt, systemPrompt, provider, model, providerConfig, resolvedImages };
  }

  const handler = dispatchMap[effectiveMode];
  if (!handler) {
    throw new ProviderError(
      `Mode "${effectiveMode}" is not supported for provider "${provider}". Supported modes: ${Object.keys(dispatchMap).join(", ")}.`
    );
  }

  const t0 = Date.now();
  let data, resolvedModel;
  try {
    const result = await handler(dispatchContext);
    data = result.data;
    resolvedModel = result.resolvedModel;
    const usage = data?._usage || data?.usage || {};
    logProviderRequest(startTs, provider, resolvedModel, effectiveMode, "ok", {
      durationMs: Date.now() - t0, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
    });
  } catch (err) {
    logProviderRequest(startTs, provider, model || "default", effectiveMode, "error", { durationMs: Date.now() - t0, error: err.message });
    throw err;
  }

  emitTrace(data, provider, resolvedModel, effectiveMode);
  return { content: [{ type: "text", text: extractText(data) }] };
}

// ── Tool dispatch ─────────────────────────────────────────────────

export async function handleToolCall(name, args = {}, deps = {}) {
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;
  switch (name) {
    case "call":
      return await handleCall(args, deps);
    case "spawn_session": {
      if (!args.provider) throw new Error("spawn_session: provider is required");
      const desc = await _createSession({
        provider: args.provider, model: args.model, write: !!args.write,
        cwd: args.cwd || process.cwd(), observe: !!args.observe,
      });
      return textResult(JSON.stringify(desc));
    }
    case "session_send": {
      if (!args.id || !args.prompt) throw new Error("session_send: id and prompt are required");
      const res = await _sendToSession(args.id, args.prompt);
      return textResult(res.text || "(no output)");
    }
    case "session_close": {
      if (!args.id) throw new Error("session_close: id is required");
      return textResult(JSON.stringify(await _closeSession(args.id)));
    }
    case "list_sessions":
      return textResult(JSON.stringify(_listSessions()));
    case "list_providers":
      return textResult(listModels());
    case "resolve_model": {
      const cfg = loadProviderConfig(args.provider);
      if (cfg.native) return textResult(`${args.provider} is native — no model remapping.`);
      return textResult(resolveModelFromId(cfg, args.model));
    }
    case "codex_status": {
      const status = checkCodexStatus(args.codexPath || null);
      const lines = [
        `Installed: ${status.installed}`,
        status.path ? `Path: ${status.path}` : "",
        status.version ? `Version: ${status.version}` : "",
        `Authenticated: ${status.authenticated}`,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rpc.main().catch((error) => {
    process.stderr.write(`fabric-mcp fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
