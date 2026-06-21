import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
    windowsHide: true,
  });
  if (pathResult.status === 0) {
    if (process.platform === "win32") {
      // 'where codex' to resolve full path with extension
      const where = spawnSync("where", ["codex"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000, windowsHide: true });
      if (where.status === 0) {
        const lines = where.stdout.toString().trim().split("\n");
        // Prefer .cmd/.exe over extensionless (shell scripts on PATH)
        let best = null;
        for (const l of lines) {
          const p = l.trim();
          if (p.endsWith(".cmd") || p.endsWith(".exe")) { best = p; break; }
          if (!best && fs.existsSync(p)) best = p;
        }
        if (best) return best;
      }
    }
    return "codex";
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Local", "Programs", "codex", "codex.exe"),
        path.join(os.homedir(), "scoop", "apps", "codex", "current", "codex.exe"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "codex"),
        "/usr/local/bin/codex",
      ];

  for (const c of candidates) {
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
    windowsHide: true,
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
    windowsHide: true,
  });

  let authenticated = false;
  if (doctor.status === 0) {
    try {
      const report = JSON.parse(doctor.stdout.toString());
      authenticated = report?.checks?.["auth.credentials"]?.status === "ok";
    } catch { /* ignore parse errors */ }
  }

  return {
    installed: true,
    path: bin,
    version: version.stdout.toString().trim(),
    authenticated,
  };
}
