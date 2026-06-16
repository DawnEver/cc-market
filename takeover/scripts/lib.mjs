import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
export const getConfigPath = () => process.env.TAKEOVER_CONFIG_PATH || defaultConfigPath;

// ── Provider env keys (mirrors scripts/runtime/cc.js) ────────────────────────

export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
];

// ── Claude binary resolution (cross-platform) ───────────────────────────────

// On Windows, spawn(shell:false) cannot launch the `claude.cmd`/`claude.ps1`
// shims — it needs the real `claude.exe`. That .exe lives in the global npm
// prefix at node_modules/@anthropic-ai/claude-code/bin/claude.exe, but the
// prefix is install-specific (nvm4w → D:\nvm4w\nodejs, plain npm → ~\nodejs),
// so it cannot be hardcoded. Resolve it dynamically:
//   1. CLAUDE_CLI_PATH override (escape hatch)
//   2. derive from the launcher shim found on PATH
//   3. legacy ~/nodejs fallback
const CLAUDE_EXE_REL = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

export function resolveClaudeExe() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  if (process.platform !== "win32") return "claude";

  // Find the directory of a claude shim on PATH; the npm global prefix (which
  // holds the shims) also contains node_modules with the real .exe.
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const shim of ["claude.cmd", "claude.exe", "claude.ps1", "claude"]) {
      if (fs.existsSync(path.join(dir, shim))) {
        const exe = path.join(dir, CLAUDE_EXE_REL);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return path.join(os.homedir(), "nodejs", CLAUDE_EXE_REL); // legacy fallback
}

// ── Agent mode: spawn claude -p with provider env ────────────────────────────

export function loadProviderEnv(provider, configPath = getConfigPath()) {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];

  if (provider === 'claude') return env; // OAuth/Pro subscription

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const profile = config[`env:${provider}`];
  if (!profile) {
    const available = Object.keys(config)
      .filter(k => k.startsWith('env:'))
      .map(k => k.slice(4))
      .join(', ');
    throw new Error(`Provider "${provider}" not found in ${configPath}. Available: ${available}`);
  }
  Object.assign(env, profile);
  return env;
}

export async function spawnClaudeP(userPrompt, opts = {}) {
  const { provider, model, systemPrompt, images, configPath, signal } = opts;
  const cfgPath = configPath || getConfigPath();
  let env;
  const label = provider || 'claude';

  if (!provider || provider === 'claude') {
    env = process.env;
  } else {
    env = loadProviderEnv(provider, cfgPath);
    if (model) {
      const providerConfig = loadProviderConfig(provider, cfgPath);
      env.ANTHROPIC_MODEL = resolveModel(providerConfig, model);
    }
  }

  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${userPrompt}`
    : userPrompt;

  const useStdin = fullPrompt.length > 1000 || (images && images.length > 0);
  process.stderr.write(`mcp-takeover: spawning claude (provider=${label} model=${model || 'default'})${useStdin ? ' [stdin]' : ''}...\n`);

  return stdinSpawnClaude(resolveClaudeExe(), fullPrompt, useStdin, env, (code, stdout, stderr, usage) => {
    if (code === 0) return { content: [{ type: 'text', text: stdout.trim() }], _usage: usage };
    throw new Error(`claude CLI (${label}) exited ${code}: ${stderr.trim()}`);
  }, images, signal);
}

// ── Provider config ──────────────────────────────────────────────────────────

const _configCache = new Map();

export function loadProviderConfig(provider, configPath = getConfigPath()) {
  if (provider === "codex") return { native: true, provider: "codex" };
  if (provider === "claude") return { native: true, provider: "claude" };

  const cached = _configCache.get(`${provider}:${configPath}`);
  if (cached && Date.now() - cached.ts < 60000) return cached.config;

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Create it with your provider settings.`
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const envKey = `env:${provider}`;
  const env = config[envKey];
  if (!env) {
    throw new Error(
      `Provider "${provider}" not found in ${configPath}. ` +
      `Add an "env:${provider}" block.`
    );
  }

  const useFoundry = env.CLAUDE_CODE_USE_FOUNDRY === "1" || env.CLAUDE_CODE_USE_FOUNDRY === 1;
  const baseUrl = useFoundry ? env.ANTHROPIC_FOUNDRY_BASE_URL : env.ANTHROPIC_BASE_URL;
  const token = useFoundry ? env.ANTHROPIC_FOUNDRY_API_KEY : env.ANTHROPIC_AUTH_TOKEN;
  const defaultSonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const defaultOpus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const defaultHaiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!baseUrl) throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_BASE_URL" : "ANTHROPIC_BASE_URL"} in ${configPath}.`);
  if (!token)   throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_API_KEY" : "ANTHROPIC_AUTH_TOKEN"} in ${configPath}.`);

  const result = { native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku };
  _configCache.set(`${provider}:${configPath}`, { config: result, ts: Date.now() });
  return result;
}

export function clearConfigCache() { _configCache.clear(); }

// ── Model resolution ─────────────────────────────────────────────────────────

const TIER_MAP = { sonnet: 'defaultSonnet', opus: 'defaultOpus', haiku: 'defaultHaiku' };

export function resolveModel(providerConfig, requestedModel) {
  if (!requestedModel) return providerConfig.defaultSonnet;
  const tier = requestedModel.toLowerCase();
  const configKey = TIER_MAP[tier];
  if (configKey) return providerConfig[configKey] || providerConfig.defaultSonnet || requestedModel;
  return requestedModel;
}

// ── Command block parsing ──────────────────────────────────────────────────────

export function parseCommandBlock(prompt) {
  if (prompt == null) return { flags: {}, cleanPrompt: prompt || "" };
  const re = /^\s*<command>\s*\n?(.*?)\n?\s*<\/command>\s*\n?/s;
  const match = prompt.match(re);
  if (!match) return { flags: {}, cleanPrompt: prompt };

  const cmdText = match[1].trim();
  const flags = {};

  const providerMatch = cmdText.match(/--provider\s+(\S+)/);
  if (providerMatch) flags.provider = providerMatch[1];

  const modelMatch = cmdText.match(/--model\s+(\S+)/);
  if (modelMatch) flags.model = modelMatch[1];

  if (cmdText.match(/--review/)) flags.mode = "review";
  if (cmdText.match(/--image-edit/)) flags.mode = "image-edit";
  else if (cmdText.match(/--image/)) flags.mode = "image-generate";

  if (cmdText.match(/--write/)) flags.write = true;

  const cleanPrompt = prompt.replace(re, "");
  return { flags, cleanPrompt };
}

// ── Prompt building ──────────────────────────────────────────────────────────

export function buildPrompt(subcommand, userPrompt) {
  const promptsDir = path.join(SCRIPT_DIR, "..", "prompts");
  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }
  return { systemPrompt, userPrompt: userPrompt.trim() };
}

// ── TraceMe integration (NDJSON contract, no code dependency) ───────────────

const TRACEME_DIR = path.join(os.homedir(), '.claude', 'traceme');
const TAKEOVER_TRACES_FILE = path.join(TRACEME_DIR, 'takeover_traces.jsonl');

function parseTokenCount(s) {
  const t = String(s).trim().toLowerCase();
  if (t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
  return parseInt(t, 10) || 0;
}

function extractUsageFromStderr(stderr) {
  const m = stderr.match(/Tokens:\s+(\S+)\s+input,\s+(\S+)\s+output/);
  if (!m) return null;
  return { input_tokens: parseTokenCount(m[1]), output_tokens: parseTokenCount(m[2]) };
}

export function emitTakeoverTrace(entry) {
  try {
    if (!fs.existsSync(TRACEME_DIR)) fs.mkdirSync(TRACEME_DIR, { recursive: true });
    fs.appendFileSync(TAKEOVER_TRACES_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// ── Error taxonomy ──────────────────────────────────────────────────────────

export class TakeoverError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'TakeoverError';
    this.code = code || 'TAKEOVER_ERROR';
    this.retryable = retryable;
  }
}

export class ConfigError extends TakeoverError {
  constructor(message) { super(message, { code: 'CONFIG_ERROR', retryable: false }); this.name = 'ConfigError'; }
}

export class ProviderError extends TakeoverError {
  constructor(message, retryable = false) { super(message, { code: 'PROVIDER_ERROR', retryable }); this.name = 'ProviderError'; }
}

export class TimeoutError extends TakeoverError {
  constructor(message) { super(message, { code: 'TIMEOUT_ERROR', retryable: true }); this.name = 'TimeoutError'; }
}

export class AuthError extends TakeoverError {
  constructor(message) { super(message, { code: 'AUTH_ERROR', retryable: false }); this.name = 'AuthError'; }
}

// ── Codex integration ────────────────────────────────────────────────────────

export { findCodexBinary, checkCodexStatus } from "./codex/discovery.mjs";

// ── Text extraction ──────────────────────────────────────────────────────────

export function extractText(data) {
  const content = data.content || [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text && content.length > 0) {
    const types = [...new Set(content.map((b) => b.type))].join(", ");
    process.stderr.write(`takeover: warning — response contained no text blocks (got: ${types})\n`);
  }
  return text;
}

// ── Model listing ────────────────────────────────────────────────────────────

export function listModels(configPath = getConfigPath()) {
  const lines = [];

  lines.push("claude   — Native Claude CLI (OAuth/Pro subscription)");
  lines.push("codex    — OpenAI Codex (via codex app-server; supports --review, --image, --write)");

  if (!fs.existsSync(configPath)) {
    lines.push("");
    lines.push(`Config file not found at ${configPath}.`);
    return lines.join("\n");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const apiProviders = Object.keys(config)
    .filter((k) => k.startsWith("env:") && (config[k].ANTHROPIC_BASE_URL || config[k].ANTHROPIC_FOUNDRY_BASE_URL))
    .map((k) => k.slice(4));

  if (apiProviders.length === 0) {
    lines.push("");
    lines.push("No API-based providers configured.");
    return lines.join("\n");
  }

  lines.push("");
  for (const name of apiProviders) {
    const env = config[`env:${name}`];
    const models = [];
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push(`haiku=${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(`sonnet=${env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(`opus=${env.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
    const baseUrl = env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_BASE_URL || "?";
    const modelInfo = models.length > 0 ? models.join(", ") : "no defaults set";
    lines.push(`${name.padEnd(8)} → ${baseUrl}  [${modelInfo}]`);
  }

  return lines.join("\n");
}

// ── Shared: spawn claude.exe with stdin (stream-json for large prompts) ─────

// Watchdog kill timer for spawned children. The child_process `timeout` option
// is unusable here: on spawn ENOENT Node emits 'error' but never 'exit', so its
// internal kill timer is never cleared and keeps the event loop alive for the
// full timeout. This timer is unref'd (never blocks process exit) and explicitly
// cleared on 'close'/'error'.
function armKillTimer(child, ms) {
  const t = globalThis.setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, ms);
  t.unref?.();
  return t;
}

function stdinSpawnClaude(bin, fullPrompt, useStdin, env, onResult, images = null, signal = null) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('Request cancelled'));
    };
    if (signal) {
      if (signal.aborted) { reject(new Error('Request cancelled')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let child;
    if (useStdin) {
      child = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      const killTimer = armKillTimer(child, 600000);
      child.stdout.on("data", (d) => {
        stdout += d;
        // Stream text progress: parse each complete line as it arrives
        const lines = d.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'assistant' && msg.message?.content) {
              const blocks = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
              for (const block of blocks) {
                const text = typeof block === 'string' ? block : (block.text || '');
                if (text) process.stderr.write(text);
              }
            } else if (msg.type === 'result' && msg.result) {
              process.stderr.write(msg.result);
            }
          } catch {}
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => { clearTimeout(killTimer); if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          const result = parseStreamJsonOutput(stdout);
          const usage = extractUsageFromStderr(stderr) || result.usage;
          resolve(onResult(code, result.text, stderr, usage));
        } catch (e) {
          reject(new Error(`claude CLI exited ${code}: ${e.message} — ${stderr.trim()}`));
        }
      });

      let content;
      if (images && images.length > 0) {
        content = [{ type: "text", text: fullPrompt }];
        for (const img of images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.media_type || "image/png",
              data: img.data,
            },
          });
        }
        process.stderr.write(`mcp-takeover: stream-json with ${images.length} image block(s)\n`);
      } else {
        content = fullPrompt;
      }
      const msg = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
      child.stdin.write(msg);
      child.stdin.end();
    } else {
      child = spawn(bin, ["-p", fullPrompt], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      const killTimer = armKillTimer(child, 300000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => { clearTimeout(killTimer); if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          const usage = extractUsageFromStderr(stderr);
          resolve(onResult(code, stdout, stderr, usage));
        } catch (e) {
          reject(e);
        }
      });
    }
  });
}

function parseStreamJsonOutput(raw) {
  const lines = raw.split("\n").filter(l => l.trim());
  let text = "";
  let usage = null;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "assistant") {
        // Extract text from assistant message content blocks
        if (msg.message?.content) {
          for (const block of (Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content])) {
            if (block.type === "text" || typeof block === "string") {
              text += (typeof block === "string" ? block : block.text || "");
            }
          }
        }
      } else if (msg.type === "result") {
        if (msg.result) text += msg.result;
        if (msg.usage) usage = msg.usage;
      }
    } catch {}
  }
  return { text: text.trim(), usage };
}

// ── Structured request logging (ndjson to stderr) ──────────────────────────

let _requestSeq = 0;

export function logTakeoverRequest(startTs, provider, model, mode, status, { durationMs, inputTokens, outputTokens, error } = {}) {
  _requestSeq++;
  const entry = {
    ts: startTs,
    request_id: `tk-${startTs.replace(/[^0-9]/g, '').slice(0, 14)}-${String(_requestSeq).padStart(4, '0')}`,
    provider,
    model: model || 'default',
    mode: mode || 'task',
    status,
    duration_ms: durationMs,
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    ...(error ? { error: error.slice(0, 200) } : {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ── Callers ──────────────────────────────────────────────────────────────────

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, images = null, stream = false, signal = null) {
  if (!model) throw new Error(`No model resolved for provider. Set ANTHROPIC_DEFAULT_SONNET_MODEL in ${getConfigPath()}.`);

  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;

  let content;
  if (images && images.length > 0) {
    content = [{ type: "text", text: userPrompt }];
    for (const img of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type || "image/png",
          data: img.data,
        },
      });
    }
  } else {
    content = userPrompt;
  }

  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (stream) body.stream = true;

    // Use an AbortController with a clearable, unref'd timer rather than
    // AbortSignal.timeout(): the latter's timer is neither unref'd nor cleared
    // once the fetch settles, so it keeps the event loop alive for the full
    // timeout (5 min) after the request is already done. Note `setTimeout` is
    // imported from node:timers/promises at the top of this file, so reach for
    // the global timer explicitly here.
    let timeoutCtl, timeoutId;
    if (!signal) {
      timeoutCtl = new AbortController();
      timeoutId = globalThis.setTimeout(() => timeoutCtl.abort(new Error("Request timed out")), 300000);
      timeoutId.unref?.();
    }
    const fetchSignal = signal || timeoutCtl.signal;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": providerConfig.token,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: fetchSignal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (signal?.aborted) throw new Error('Request cancelled');
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        process.stderr.write(`takeover: network error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await setTimeout(delay);
        continue;
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (res.ok) {
      if (stream && res.headers.get("content-type")?.includes("text/event-stream")) {
        try {
          return await parseSSEStream(res.body);
        } catch (streamErr) {
          process.stderr.write(`takeover: SSE streaming failed (${streamErr.message}), falling back to non-streaming...\n`);
          delete body.stream;
          continue;
        }
      }
      return res.json();
    }

    const errorText = await res.text();
    if (attempt < maxRetries && isRetryable(res.status)) {
      const delay = Math.pow(2, attempt) * 1000;
      process.stderr.write(`takeover: retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
      await setTimeout(delay);
      continue;
    }

    throw new Error(`API error ${res.status}: ${errorText}`);
  }
}

async function parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = "";
  let usage = null;
  let stopReason = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (currentEvent === "content_block_delta") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.delta?.type === "text_delta") {
              accumulatedText += parsed.delta.text;
              process.stderr.write(parsed.delta.text);
            }
          } catch {}
        } else if (currentEvent === "message_delta") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) usage = parsed.usage;
            if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          } catch {}
        }
      }
      if (line === "") currentEvent = null;
    }
  }

  return { content: [{ type: "text", text: accumulatedText }], stop_reason: stopReason, usage };
}

export async function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false, images = null, client = null) {
  const { runCodexTask } = await import("./codex/task.mjs");
  return runCodexTask(userPrompt, systemPrompt, model, writeMode, process.cwd(), (msg) => {
    process.stderr.write(`mcp-takeover[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`);
  }, images, client);
}

