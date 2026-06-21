#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

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
  emitTakeoverTrace,
  checkCodexStatus,
  logTakeoverRequest,
  ConfigError,
  ProviderError,
} from "./lib.mjs";
import { withSharedClient } from "./codex/app-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

// ── MCP stdio transport ───────────────────────────────────────────

const LINE_TRANSPORT = "line";
const FRAMED_TRANSPORT = "framed";

export function encodeRpcMessage(rpc, transport = LINE_TRANSPORT) {
  const json = JSON.stringify(rpc);
  if (transport === FRAMED_TRANSPORT) {
    return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

export function send(rpc, transport = LINE_TRANSPORT) {
  process.stdout.write(encodeRpcMessage(rpc, transport));
}

function isFramedTransport(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, "Content-Length:".length)).toString("ascii").toLowerCase();
  return "content-length:".startsWith(prefix) || prefix.startsWith("content-length:");
}

function headerEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1) return lf === -1 ? null : { index: lf, bytes: 2 };
  if (lf === -1) return { index: crlf, bytes: 4 };
  return crlf < lf ? { index: crlf, bytes: 4 } : { index: lf, bytes: 2 };
}

function parseJsonPayload(payload, preview) {
  try {
    return JSON.parse(payload);
  } catch {
    process.stderr.write(`mcp-takeover: bad JSON: ${preview.slice(0, 200)}\n`);
    return null;
  }
}

// ── Tool definitions ──────────────────────────────────────────────

export const TOOLS = [
  {
    name: "call_model",
    description:
      "Call an AI model from any configured provider. " +
      "Routes to Claude (native CLI), Codex (codex-companion), " +
      "or any Anthropic-compatible API from ~/.claude/claude_env_settings.json. " +
      "If userPrompt contains a <command> block with --provider/--model flags, " +
      "those are parsed authoritatively — the provider/model params are overridden.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Provider name: claude, codex, deepseek, " +
            "or a custom provider key from claude_env_settings.json. " +
            "Optional — parsed from <command> block if omitted.",
        },
        model: {
          type: "string",
          description: "Model name. Optional — uses provider default.",
        },
        mode: {
          type: "string",
          enum: ["task", "review", "image-generate", "image-edit", "agent"],
          description:
            "Operation mode. 'task' for code/investigation (default). " +
            "'review' for adversarial code review (codex uses its native review endpoint; " +
            "other providers run it as a task with the review system prompt). " +
            "'agent' for full tool-access via Claude Code harness + provider env. " +
            "'image-generate' for image generation (codex only). " +
            "'image-edit' for image editing (codex only). " +
            "Parsed from <command> block flags: --review, --image, --image-edit.",
        },
        write: {
          type: "boolean",
          description:
            "For codex provider only: enable write mode so the model can edit files. " +
            "Ignored for non-codex providers.",
        },
        systemPrompt: {
          type: "string",
          description: "Custom system prompt. Overrides mode if both set.",
        },
        userPrompt: {
          type: "string",
          description: "The user message or task to hand off.",
        },
        images: {
          type: "array",
          description: "Optional image attachments. Each image is base64-encoded with a media type.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Original file path (for reference)" },
              data: { type: "string", description: "Base64-encoded image data" },
              media_type: { type: "string", description: "MIME type, e.g. image/png, image/jpeg" },
            },
          },
        },
      },
      required: ["userPrompt"],
    },
  },
  {
    name: "list_models",
    description: "List all available providers and their configured models.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "codex_status",
    description: "Check Codex CLI installation status, version, and authentication state.",
    inputSchema: {
      type: "object",
      properties: {
        codexPath: {
          type: "string",
          description: "Optional path to codex binary. Auto-detected if omitted.",
        },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────

// ── Image helpers ──────────────────────────────────────────────────

const EXT_TO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
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
        const ext = (img.path.match(/\.\w+$/i) || ['.png'])[0].toLowerCase();
        resolved.push({
          path: img.path,
          data: raw.toString('base64'),
          media_type: img.media_type || EXT_TO_MIME[ext] || 'image/png',
        });
      } catch (e) {
        process.stderr.write(`mcp-takeover: failed to read image ${img.path}: ${e.message}\n`);
      }
    }
  }
  return resolved;
}

function checkImageSizeLimit(resolvedImages, provider, providerConfig) {
  // API path uses structured content blocks — no size limit needed
  if (provider === 'codex' || providerConfig.baseUrl) return;

  const oversized = resolvedImages.filter(img => img.data.length > MAX_DATA_URI_BYTES);
  if (oversized.length > 0) {
    const sizes = oversized.map(img => `${img.path || 'image'} (${(img.data.length / 1024).toFixed(0)}KB)`).join(', ');
    throw new ConfigError(
      `Image(s) too large for text-prompt embedding: ${sizes}. ` +
      `Max ${MAX_DATA_URI_BYTES / 1000}KB per image. ` +
      `Options: (1) pre-resize images, (2) use an API provider (--provider <api>) that supports structured content blocks, ` +
      `(3) use --provider codex which routes images natively.`
    );
  }

  if (provider === 'claude') {
    const big = resolvedImages.some(img => img.data.length > MAX_DATA_URI_BYTES);
    if (big) {
      process.stderr.write(`mcp-takeover: WARNING — image base64 >150KB may inflate token count. Prefer pre-resized images.\n`);
    }
  }
}

function emitTrace(data, provider, resolvedModel, mode) {
  const usage = data?._usage || data?.usage || null;
  emitTakeoverTrace({
    ts: new Date().toISOString(),
    provider,
    model: resolvedModel || 'default',
    mode: mode || 'task',
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read: usage?.cache_read_input_tokens || 0,
    cache_write: usage?.cache_creation_input_tokens || 0,
  });
}

// ── Provider dispatch ─────────────────────────────────────────────

// -- codex provider handlers --

async function dispatchCodexTask({ userPrompt, systemPrompt, model, write, resolvedImages, signal }) {
  const hasImages = resolvedImages.length > 0;
  process.stderr.write(
    `mcp-takeover: calling codex (${model || "default"})${write ? " [write]" : ""}${hasImages ? ` + ${resolvedImages.length} image(s)` : ""}...\n`
  );
  const data = await withSharedClient(client =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, hasImages ? resolvedImages : null, client));
  return { data, resolvedModel: model || 'default' };
}

async function dispatchCodexAgent({ userPrompt, systemPrompt, model, write, resolvedImages, signal }) {
  process.stderr.write(`mcp-takeover: agent mode — provider=codex model=${model || '(none)'}\n`);
  const data = await withSharedClient(client =>
    callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, resolvedImages.length > 0 ? resolvedImages : null, client));
  return { data, resolvedModel: model || 'default' };
}

async function dispatchCodexReview({ userPrompt, systemPrompt, model, imageURIs, signal }) {
  process.stderr.write(`mcp-takeover: codex review (adversarial)...\n`);
  const promptWithImages = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
  const { runCodexReview } = await import("./codex/review.mjs");
  const data = await withSharedClient(client =>
    runCodexReview(promptWithImages, model || null, null, process.cwd(), client));
  return { data, resolvedModel: model || 'default' };
}

async function dispatchCodexImageGenerate({ userPrompt, signal }) {
  process.stderr.write(`mcp-takeover: codex image generate (app-server)...\n`);
  const { generateImage } = await import("./codex/image.mjs");
  const data = await withSharedClient(client => generateImage(userPrompt, { client }));
  return { data, resolvedModel: 'codex-image-gen' };
}

async function dispatchCodexImageEdit({ userPrompt, systemPrompt, signal }) {
  process.stderr.write(`mcp-takeover: codex image edit (app-server)...\n`);
  const { handleImageEdit } = await import("./codex/image.mjs");
  const data = await withSharedClient(client => handleImageEdit(userPrompt, systemPrompt, { client }));
  return { data, resolvedModel: 'codex-image-edit' };
}

const CODEX_DISPATCH = {
  task: dispatchCodexTask,
  agent: dispatchCodexAgent,
  review: dispatchCodexReview,
  'image-generate': dispatchCodexImageGenerate,
  'image-edit': dispatchCodexImageEdit,
};

// -- claude native handlers --

async function dispatchClaudeTask({ userPrompt, systemPrompt, resolvedImages, signal }) {
  process.stderr.write("mcp-takeover: calling claude (native CLI)...\n");
  const data = await spawnClaudeP(userPrompt, { systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: 'claude' };
}

async function dispatchClaudeAgent({ userPrompt, systemPrompt, provider, model, resolvedImages, signal }) {
  process.stderr.write(`mcp-takeover: agent mode — provider=${provider} model=${model || '(none)'}\n`);
  const data = await spawnClaudeP(userPrompt, { provider, model: model || null, systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: model || 'claude' };
}

const CLAUDE_DISPATCH = {
  task: dispatchClaudeTask,
  agent: dispatchClaudeAgent,
  // Non-codex providers have no dedicated adversarial-review endpoint; review mode
  // runs as a task with the review system prompt (built from mode in handleCallModel).
  review: dispatchClaudeTask,
};

// -- API provider handlers --

async function dispatchAPITask({ userPrompt, systemPrompt, providerConfig, model, signal }) {
  const resolvedModel = resolveModel(providerConfig, model || null);
  process.stderr.write(`mcp-takeover: calling ${resolvedModel} (API)...\n`);
  const data = await callAnthropicAPI(providerConfig, resolvedModel, systemPrompt, userPrompt, null, true, signal);
  const usage = data.usage || {};
  process.stderr.write(
    `mcp-takeover: ${data.stop_reason || "done"}, ` +
    `in=${usage.input_tokens || "?"} out=${usage.output_tokens || "?"}\n`
  );
  return { data, resolvedModel };
}

async function dispatchAPIAgent({ userPrompt, systemPrompt, provider, model, resolvedImages, signal }) {
  process.stderr.write(`mcp-takeover: agent mode — provider=${provider} model=${model || '(none)'}\n`);
  const data = await spawnClaudeP(userPrompt, { provider, model: model || null, systemPrompt, images: resolvedImages.length > 0 ? resolvedImages : null, signal });
  return { data, resolvedModel: model || provider };
}

const API_DISPATCH = {
  task: dispatchAPITask,
  agent: dispatchAPIAgent,
  // See CLAUDE_DISPATCH.review — review runs as a task with the review system prompt.
  review: dispatchAPITask,
};

export { API_DISPATCH, CLAUDE_DISPATCH, CODEX_DISPATCH };

// ── Main handler ──────────────────────────────────────────────────

export async function handleCallModel(args) {
  let { provider, model, mode, systemPrompt: customSystem, userPrompt, write, images } = args;
  const startTs = new Date().toISOString();

  // Parse <command> block from userPrompt — authoritative flag source.
  const parsed = parseCommandBlock(userPrompt);
  if (parsed.flags.provider) provider = parsed.flags.provider;
  if (parsed.flags.model) model = parsed.flags.model;
  userPrompt = parsed.cleanPrompt;
  if (parsed.flags.write && write === undefined) write = true;

  process.stderr.write(`mcp-takeover: call_model args: provider=${provider} model=${model || "(none)"} mode=${mode || "(none)"} write=${!!write}\n`);

  if (!provider) throw new ConfigError("provider is required — pass it directly or include --provider <name> in a <command> block in userPrompt");
  if (!userPrompt || !userPrompt.trim()) {
    throw new ConfigError("userPrompt must be non-empty");
  }

  let systemPrompt = customSystem || "";
  if (!customSystem && mode) {
    systemPrompt = buildPrompt(mode, userPrompt).systemPrompt;
  }

  const resolvedImages = resolveImages(images);
  const imageURIs = resolvedImages.length > 0
    ? resolvedImages.map(img => `data:${img.media_type};base64,${img.data}`).join('\n')
    : '';

  const providerConfig = loadProviderConfig(provider);
  checkImageSizeLimit(resolvedImages, provider, providerConfig);

  // Route to provider dispatch
  const effectiveMode = mode || 'task';
  let dispatchMap, dispatchContext;

  if (providerConfig.provider === 'codex') {
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
      `Mode "${effectiveMode}" is not supported for provider "${provider}". ` +
      `Supported modes: ${Object.keys(dispatchMap).join(', ')}.`
    );
  }

  const t0 = Date.now();
  let data, resolvedModel;
  try {
    const result = await handler(dispatchContext);
    data = result.data;
    resolvedModel = result.resolvedModel;
    const durationMs = Date.now() - t0;
    const usage = data?._usage || data?.usage || {};
    logTakeoverRequest(startTs, provider, resolvedModel, effectiveMode, 'ok', {
      durationMs,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    logTakeoverRequest(startTs, provider, model || 'default', effectiveMode, 'error', {
      durationMs,
      error: err.message,
    });
    throw err;
  }

  emitTrace(data, provider, resolvedModel, effectiveMode);

  return { content: [{ type: "text", text: extractText(data) }] };
}

export async function handleToolCall(name, args) {
  switch (name) {
    case "call_model":
      return await handleCallModel(args);
    case "list_models":
      return { content: [{ type: "text", text: listModels() }] };
    case "codex_status": {
      const status = checkCodexStatus(args.codexPath || null);
      const lines = [
        `Installed: ${status.installed}`,
        status.path ? `Path: ${status.path}` : "",
        status.version ? `Version: ${status.version}` : "",
        `Authenticated: ${status.authenticated}`,
        status.error ? `Error: ${status.error}` : "",
      ];
      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────

export async function handleRpcRequest(req, transport = LINE_TRANSPORT) {
  const { id, method, params = {} } = req;

  try {
    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        }, transport);
        break;

      case "ping":
        send({ jsonrpc: "2.0", id, result: {} }, transport);
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }, transport);
        break;

      case "tools/call":
        send({
          jsonrpc: "2.0",
          id,
          result: await handleToolCall(params.name, params.arguments || {}),
        }, transport);
        break;

      default:
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        }, transport);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("not found") ? -32602 : -32000;
    send({ jsonrpc: "2.0", id, error: { code, message } }, transport);
  }
}

async function main(input = process.stdin) {
  let buffer = Buffer.alloc(0);

  for await (const chunk of input) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, incoming]);

    while (buffer.length > 0) {
      if (buffer[0] === 0x0a || buffer[0] === 0x0d) {
        buffer = buffer.subarray(1);
        continue;
      }

      if (isFramedTransport(buffer)) {
        const end = headerEnd(buffer);
        if (!end) break;

        const header = buffer.subarray(0, end.index).toString("ascii");
        const match = /^Content-Length:\s*(\d+)$/im.exec(header);
        if (!match) {
          process.stderr.write(`mcp-takeover: bad MCP header: ${header.slice(0, 200)}\n`);
          buffer = buffer.subarray(end.index + end.bytes);
          continue;
        }

        const length = Number(match[1]);
        const bodyStart = end.index + end.bytes;
        const bodyEnd = bodyStart + length;
        if (buffer.length < bodyEnd) break;

        const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.subarray(bodyEnd);

        const req = parseJsonPayload(body, body);
        if (req) await handleRpcRequest(req, FRAMED_TRANSPORT);
        continue;
      }

      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;

      const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (!line) continue;

      const req = parseJsonPayload(line, line);
      if (req) await handleRpcRequest(req, LINE_TRANSPORT);
    }
  }

  const trailing = buffer.toString("utf8").trim();
  if (trailing && !isFramedTransport(buffer)) {
    const req = parseJsonPayload(trailing, trailing);
    if (req) await handleRpcRequest(req, LINE_TRANSPORT);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`mcp-takeover fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
