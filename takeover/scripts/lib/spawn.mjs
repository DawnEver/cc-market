// spawn.mjs — Claude binary resolution + spawning claude -p (stream-json for large
// prompts / images). Re-exported via scripts/lib.mjs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { getConfigPath, loadProviderEnv, loadProviderConfig, resolveModel } from "./config.mjs";
import { extractUsageFromStderr } from "./trace.mjs";

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
