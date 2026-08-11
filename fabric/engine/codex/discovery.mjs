import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnSync } from "../../shared/spawn.mjs";

const execFileP = promisify(execFile);
/** Await a command → { status, stdout, stderr, error? }. Never blocks the event loop. */
async function runAsync(cmd, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: timeoutMs, encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
    return { status: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    // exit-code != 0 rejects; map to a sync-spawn-like shape. e.stdout may be a Buffer/string.
    return { status: e.code ?? -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message), error: e };
  }
}

// Shared pure decision helpers — sync and async paths must agree on WHERE codex could
// live and which of several PATH hits to prefer, so the two can't drift apart.

function codexCandidates() {
  return process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Local", "Programs", "codex", "codex.exe"),
        path.join(os.homedir(), "scoop", "apps", "codex", "current", "codex.exe"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "codex"),
        "/usr/local/bin/codex",
      ];
}

/** Prefer .cmd/.exe over extensionless (shell scripts on PATH). */
function pickWhereBest(lines) {
  let best = null;
  for (const l of lines) {
    const p = l.trim();
    if (p.endsWith(".cmd") || p.endsWith(".exe")) { best = p; break; }
    if (!best && fs.existsSync(p)) best = p;
  }
  return best;
}

function parseAuth(doctorOut) {
  try {
    const report = JSON.parse(doctorOut);
    return report?.checks?.["auth.credentials"]?.status === "ok";
  } catch { return false; }
}

export function findCodexBinary() {
  if (process.env.TAKEOVER_CODEX_BINARY) {
    const p = process.env.TAKEOVER_CODEX_BINARY;
    if (!fs.existsSync(p)) throw new Error(`TAKEOVER_CODEX_BINARY not found: ${p}`);
    return p;
  }

  const pathResult = spawnSync("codex", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    shell: process.platform === "win32",
  });
  if (pathResult.status === 0) {
    if (process.platform === "win32") {
      // 'where codex' to resolve full path with extension
      const where = spawnSync("where", ["codex"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
      if (where.status === 0) {
        const best = pickWhereBest(where.stdout.toString().trim().split("\n"));
        if (best) return best;
      }
    }
    return "codex";
  }

  for (const c of codexCandidates()) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    "Codex CLI not found. Install from https://github.com/openai/codex or set TAKEOVER_CODEX_BINARY."
  );
}

export async function findCodexBinaryAsync() {
  if (process.env.TAKEOVER_CODEX_BINARY) {
    const p = process.env.TAKEOVER_CODEX_BINARY;
    if (!fs.existsSync(p)) throw new Error(`TAKEOVER_CODEX_BINARY not found: ${p}`);
    return p;
  }

  const pathResult = await runAsync("codex", ["--version"], 10000);
  if (pathResult.status === 0) {
    if (process.platform === "win32") {
      const where = await runAsync("where", ["codex"], 5000);
      if (where.status === 0) {
        const best = pickWhereBest(where.stdout.trim().split("\n"));
        if (best) return best;
      }
    }
    return "codex";
  }

  for (const c of codexCandidates()) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    "Codex CLI not found. Install from https://github.com/openai/codex or set TAKEOVER_CODEX_BINARY."
  );
}

export function checkCodexStatus(codexPath) {
  const bin = codexPath || findCodexBinary();

  const version = spawnSync(bin, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    shell: process.platform === "win32",
  });

  if (version.error || version.status !== 0) {
    // spawn failure (e.g. ENOENT) leaves stderr null and status null — fall back to error/status.
    const detail = version.error
      ? version.error.message
      : version.stderr?.toString().trim() || `exited with status ${version.status}`;
    return { installed: false, error: detail };
  }

  // Check auth via `codex doctor` — `codex account read` doesn't exist in v0.137+
  const doctor = spawnSync(bin, ["doctor", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    shell: process.platform === "win32",
  });

  let authenticated = false;
  if (doctor.status === 0 && doctor.stdout) {
    authenticated = parseAuth(doctor.stdout.toString());
  }

  return {
    installed: true,
    path: bin,
    version: version.stdout.toString().trim(),
    authenticated,
  };
}

/** Async twin for the console's catalogue — the sync version BLOCKS the event loop for
 *  up to ~40s (codex --version ×2 + doctor), which froze the web console on every
 *  catalogue refresh. Same logic, spawn-based, never blocks. */
export async function checkCodexStatusAsync(codexPath) {
  const bin = codexPath || await findCodexBinaryAsync();

  const version = await runAsync(bin, ["--version"], 10000);
  if (version.status !== 0) {
    const detail = version.error?.message || version.stderr?.trim() || `exited with status ${version.status}`;
    return { installed: false, error: detail };
  }

  const doctor = await runAsync(bin, ["doctor", "--json"], 15000);
  let authenticated = false;
  if (doctor.status === 0 && doctor.stdout) {
    authenticated = parseAuth(doctor.stdout);
  }

  return {
    installed: true,
    path: bin,
    version: version.stdout.trim(),
    authenticated,
  };
}
