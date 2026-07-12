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
//                      (engine/session.mjs) across discrete tool calls. codex + claude + API.
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
  truncateText,
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
import { withPooledClient } from "../engine/codex/app-server.mjs";
import { resolveModelFromId } from "../engine/providers.mjs";
import { spawnChild } from "../engine/spawn-child.mjs";
import { summarizeFile } from "../engine/observe-reader.mjs";
import { createSession, sendToSession, closeSession, listSessions, getSessionProvider, createTeam, sendToTeamWorker, getTeamStatus, closeTeam } from "../engine/session.mjs";
import { createStdioServer, encodeRpcMessage } from "../engine/mcp-rpc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

const textResult = (s) => ({ content: [{ type: "text", text: s }] });

// ── Tool definitions ──────────────────────────────────────────────

export const TOOLS = [
  {
    name: "call",
    description: "Invoke a model. <command> block flags in prompt override params. For persistent multi-turn use spawn_session.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "claude, codex, deepseek, or key from claude_env_settings.json" },
        model: { type: "string", description: "Model override" },
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
          description: "summary|full|truncate. Default: summary",
        },
        maxResultChars: { type: "number", description: "Cap when truncate. 0=unlimited" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "spawn_session",
    description: "Open a persistent multi-turn session. Drive with session_send, close with session_close.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "codex|claude|deepseek|…" },
        model: { type: "string", description: "Model override" },
        write: { type: "boolean", description: "Allow file writes" },
        cwd: { type: "string", description: "Working dir" },
        observe: { type: "boolean", description: "Capture HTTP traffic" },
      },
      required: ["provider"],
    },
  },
  {
    name: "session_send",
    description: "Send a turn to a session. Context retained across turns.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session id" },
        prompt: { type: "string", description: "Turn text" },
        resultMode: { type: "string", enum: ["summary", "full", "truncate"], description: "Default: summary" },
      },
      required: ["id", "prompt"],
    },
  },
  {
    name: "session_close",
    description: "Close a session and free its process.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Session id" } },
      required: ["id"],
    },
  },
  {
    name: "list_sessions",
    description: "List open sessions (id, provider, turn count).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_spawn",
    description: "Create a fleet of workers. Drive with team_send, close with team_close.",
    inputSchema: {
      type: "object",
      properties: {
        workers: {
          type: "array",
          description: "Worker specs",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Worker name" },
              provider: { type: "string" },
              model: { type: "string", description: "Model override" },
              write: { type: "boolean", description: "Allow file writes" },
              cwd: { type: "string", description: "Working dir" },
            },
            required: ["id", "provider"],
          },
        },
      },
      required: ["workers"],
    },
  },
  {
    name: "team_send",
    description: "Send a turn to a team worker.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team id" },
        workerId: { type: "string", description: "Worker id" },
        prompt: { type: "string", description: "Turn text" },
      },
      required: ["teamId", "workerId", "prompt"],
    },
  },
  {
    name: "team_status",
    description: "Get status of all workers in a team.",
    inputSchema: {
      type: "object",
      properties: { teamId: { type: "string", description: "Team id" } },
      required: ["teamId"],
    },
  },
  {
    name: "team_synthesize",
    description: "Synthesize all worker contexts into a summary.",
    inputSchema: {
      type: "object",
      properties: { teamId: { type: "string", description: "Team id" } },
      required: ["teamId"],
    },
  },
  {
    name: "team_close",
    description: "Close all team sessions and free resources.",
    inputSchema: {
      type: "object",
      properties: { teamId: { type: "string", description: "Team id" } },
      required: ["teamId"],
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
    description: "Run N tasks in parallel, return compact JSON. Each auto-summarized. Optional synthesis.",
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
              cwd: { type: "string", description: "Working dir" },
            },
            required: ["provider", "prompt"],
          },
        },
        synthesize: { type: "boolean", description: "Synthesize results into summary. Default true" },
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

// ── Result shaping: keep parent context clean ─────────────────────

const SUMMARIZE_PROMPT = "Condense the following into a tight summary for a parent orchestrator. Keep: key findings, decisions, file changes, errors, next steps. Drop: narration, greetings, markdown fluff, play-by-play. 3-5 sentences max.";
const SUMMARY_THRESHOLD = 2000;

async function summarizeOutput(fullText, providerConfig, provider) {
  if (!fullText || fullText.length <= SUMMARY_THRESHOLD) return fullText;

  // Path 1: API provider (deepseek etc.) → fast HTTP call with haiku-tier model
  if (providerConfig.baseUrl) {
    try {
      const summaryModel = providerConfig.defaultHaiku || providerConfig.defaultSonnet;
      const data = await callAnthropicAPI(providerConfig, summaryModel, SUMMARIZE_PROMPT, fullText, null, true);
      return extractText(data) + `\n\n[Full: ${fullText.length} chars → resultMode:"full"]`;
    } catch (e) {
      process.stderr.write(`fabric-mcp: API summary via ${provider} failed (${e.message})\n`);
    }
  }

  // Path 2: codex → app-server summary task (native protocol, no HTTP needed)
  if (provider === "codex") {
    try {
      const data = await withPooledClient((client) =>
        callCodexCompanion(fullText, SUMMARIZE_PROMPT, null, false, null, client));
      return extractText(data) + `\n\n[Full: ${fullText.length} chars → resultMode:"full"]`;
    } catch (e) {
      process.stderr.write(`fabric-mcp: codex summary failed (${e.message})\n`);
    }
  }

  // Path 3: native claude without own API → try deepseek as backstop summarizer
  if (!providerConfig.baseUrl && provider !== "codex") {
    try {
      const dsConfig = loadProviderConfig("deepseek");
      if (dsConfig.baseUrl) {
        const summaryModel = dsConfig.defaultHaiku || dsConfig.defaultSonnet;
        const data = await callAnthropicAPI(dsConfig, summaryModel, SUMMARIZE_PROMPT, fullText, null, true);
        return extractText(data) + `\n\n[Full: ${fullText.length} chars → resultMode:"full"]`;
      }
    } catch {}
  }

  return truncateText(fullText, 4000);
}

// ── Provider dispatch (policy: mode × provider) ────────────────────

async function dispatchCodexTask({ userPrompt, systemPrompt, model, write, resolvedImages }) {
  const hasImages = resolvedImages.length > 0;
  process.stderr.write(`fabric-mcp: calling codex (${model || "default"})${write ? " [write]" : ""}${hasImages ? ` + ${resolvedImages.length} image(s)` : ""}...\n`);
  const data = await withPooledClient((client) =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, hasImages ? resolvedImages : null, client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexAgent({ userPrompt, systemPrompt, model, write, resolvedImages }) {
  process.stderr.write(`fabric-mcp: agent mode — provider=codex model=${model || "(none)"}\n`);
  const data = await withPooledClient((client) =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, resolvedImages.length > 0 ? resolvedImages : null, client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexReview({ userPrompt, model, imageURIs }) {
  process.stderr.write(`fabric-mcp: codex review (adversarial)...\n`);
  const promptWithImages = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
  const { runCodexReview } = await import("./codex/review.mjs");
  const data = await withPooledClient((client) => runCodexReview(promptWithImages, model || null, null, process.cwd(), client));
  return { data, resolvedModel: model || "default" };
}

async function dispatchCodexImageGenerate({ userPrompt }) {
  process.stderr.write(`fabric-mcp: codex image generate (app-server)...\n`);
  const { generateImage } = await import("./codex/image.mjs");
  const data = await withPooledClient((client) => generateImage(userPrompt, { client }));
  return { data, resolvedModel: "codex-image-gen" };
}

async function dispatchCodexImageEdit({ userPrompt, systemPrompt }) {
  process.stderr.write(`fabric-mcp: codex image edit (app-server)...\n`);
  const { handleImageEdit } = await import("./codex/image.mjs");
  const data = await withPooledClient((client) => handleImageEdit(userPrompt, systemPrompt, { client }));
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
  const fullText = extractText(data);
  const resultMode = args.resultMode || "summary";
  let resultText;
  if (resultMode === "full") {
    resultText = fullText;
  } else if (resultMode === "truncate") {
    resultText = truncateText(fullText, args.maxResultChars ?? 2000);
  } else {
    resultText = await summarizeOutput(fullText, providerConfig, provider);
  }
  return { content: [{ type: "text", text: resultText }] };
}

// ── fan_out: the orchestrator's parallel-work primitive ─────────

export async function handleFanOut(args, deps) {
  const { tasks, synthesize = true } = args;
  if (!tasks || !tasks.length) throw new ConfigError("fan_out: tasks array is required and must be non-empty");

  let idx = 0;
  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const i = idx++;
      const id = task.id || `task-${i}`;
      const t0 = Date.now();
      try {
        const res = await handleCall({
          provider: task.provider,
          prompt: task.prompt,
          mode: task.mode || "task",
          write: !!task.write,
          model: task.model,
          resultMode: "summary",
          cwd: task.cwd,
        }, deps);
        const text = res.content[0].text;
        const fullMatch = text.match(/\[Full: (\d+) chars/);
        const summary = fullMatch
          ? text.slice(0, text.lastIndexOf("\n\n[Full:")).trim()
          : text;
        return {
          id, ok: true,
          summary: summary.length > 400 ? summary.slice(0, 397) + "..." : summary,
          estTokens: { in: Math.round((fullMatch ? parseInt(fullMatch[1]) : text.length) / 4), out: Math.round(text.length / 4) },
          durationMs: Date.now() - t0,
        };
      } catch (e) {
        return { id, ok: false, error: e.message.slice(0, 200), durationMs: Date.now() - t0 };
      }
    }),
  );

  const results = settled.map((s) => s.status === "fulfilled" ? s.value : { ok: false, error: s.reason?.message?.slice(0, 200) || "unknown error" });

  let synthesis = null;
  if (synthesize) {
    const summaryText = results.map((r) =>
      `[${r.id}] ${r.ok ? r.summary : `FAILED: ${r.error}`}`,
    ).join("\n");
    try {
      const dsConfig = loadProviderConfig("deepseek");
      if (dsConfig.baseUrl) {
        const data = await callAnthropicAPI(
          dsConfig, dsConfig.defaultHaiku || dsConfig.defaultSonnet,
          "Synthesize these N parallel task results into a 2-3 sentence summary for the orchestrator. Flag failures, patterns, and follow-ups.",
          summaryText, null, true,
        );
        synthesis = extractText(data);
      }
    } catch { /* synthesis is best-effort */ }
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
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;
  const _createTeam = deps.createTeam || createTeam;
  const _sendToTeamWorker = deps.sendToTeamWorker || sendToTeamWorker;
  const _getTeamStatus = deps.getTeamStatus || getTeamStatus;
  const _closeTeam = deps.closeTeam || closeTeam;
  switch (name) {
    case "call":
      return await handleCall(args, deps);
    case "fan_out":
      return await handleFanOut(args, deps);
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
      const fullText = res.text || "(no output)";
      const resultMode = args.resultMode || "summary";
      let resultText;
      if (resultMode === "full") {
        resultText = fullText;
      } else if (resultMode === "truncate") {
        resultText = truncateText(fullText, 2000);
      } else {
        const sessionProvider = getSessionProvider(args.id);
        if (sessionProvider) {
          try {
            const cfg = loadProviderConfig(sessionProvider);
            resultText = await summarizeOutput(fullText, cfg, sessionProvider);
          } catch { resultText = truncateText(fullText, 4000); }
        } else {
          resultText = truncateText(fullText, 4000);
        }
      }
      return textResult(resultText);
    }
    case "session_close": {
      if (!args.id) throw new Error("session_close: id is required");
      return textResult(JSON.stringify(await _closeSession(args.id)));
    }
    case "team_spawn": {
      if (!args.workers || !args.workers.length) throw new Error("team_spawn: workers array is required");
      const desc = await _createTeam(args.workers);
      return textResult(JSON.stringify(desc));
    }
    case "team_send": {
      if (!args.teamId || !args.workerId || !args.prompt) throw new Error("team_send: teamId, workerId, and prompt are required");
      const res = await _sendToTeamWorker(args.teamId, args.workerId, args.prompt);
      const fullText = res.text || "(no output)";
      const resultMode = args.resultMode || "summary";
      let resultText;
      if (resultMode === "full") {
        resultText = fullText;
      } else if (resultMode === "truncate") {
        resultText = truncateText(fullText, 2000);
      } else {
        const worker = _getTeamStatus(args.teamId).find(w => w.id === args.workerId);
        const workerProvider = worker ? getSessionProvider(worker.sessionId) : null;
        if (workerProvider) {
          try {
            const cfg = loadProviderConfig(workerProvider);
            resultText = await summarizeOutput(fullText, cfg, workerProvider);
          } catch { resultText = truncateText(fullText, 4000); }
        } else {
          resultText = truncateText(fullText, 4000);
        }
      }
      return textResult(resultText);
    }
    case "team_status": {
      if (!args.teamId) throw new Error("team_status: teamId is required");
      return textResult(JSON.stringify(_getTeamStatus(args.teamId)));
    }
    case "team_synthesize": {
      if (!args.teamId) throw new Error("team_synthesize: teamId is required");
      const status = _getTeamStatus(args.teamId);
      // Summarize from status only (no full-turn fetch — lightweight)
      const summary = status.map(w => `[${w.id}] provider=${w.provider} turns=${w.turns}`).join("\n");
      let synthesis = null;
      try {
        const dsConfig = loadProviderConfig("deepseek");
        if (dsConfig.baseUrl) {
          const data = await callAnthropicAPI(
            dsConfig, dsConfig.defaultHaiku || dsConfig.defaultSonnet,
            "Synthesize this team status into a 2-3 sentence view for the orchestrator. Note worker activity levels and any patterns.",
            summary, null, true,
          );
          synthesis = extractText(data);
        }
      } catch { /* best-effort */ }
      return textResult(JSON.stringify({ teamId: args.teamId, workers: status, synthesis }));
    }
    case "team_close": {
      if (!args.teamId) throw new Error("team_close: teamId is required");
      return textResult(JSON.stringify(await _closeTeam(args.teamId)));
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
