// engine/agy/discovery.mjs — Antigravity CLI (`agy`) binary resolution and status check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnSync } from "../../shared/spawn.mjs";
import { prepareCodexLaunch } from "../codex/launch.mjs";

const execFileP = promisify(execFile);

function agyCandidates() {
  return process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "agy", "agy.exe"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "agy"),
        "/usr/local/bin/agy",
      ];
}

function pickWhereBest(lines) {
  let best = null;
  for (const l of lines) {
    const p = l.trim();
    if (p.endsWith(".exe") || p.endsWith(".cmd")) { best = p; break; }
    if (!best && fs.existsSync(p)) best = p;
  }
  return best;
}

function runSync(cmd, args, timeout) {
  const launch = prepareCodexLaunch(cmd, args);
  return spawnSync(launch.command, launch.args, { ...launch.options, stdio: ["ignore", "pipe", "pipe"], timeout });
}

async function runAsync(cmd, args, timeoutMs) {
  try {
    const launch = prepareCodexLaunch(cmd, args);
    const { stdout, stderr } = await execFileP(launch.command, launch.args, {
      ...launch.options, timeout: timeoutMs, encoding: "utf8", windowsHide: true,
    });
    return { status: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    return { status: e.code ?? -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message), error: e };
  }
}

export function parseAgyModels(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      return { id: id.trim(), displayName: rest.join("\t").trim() || id.trim() };
    });
}

export function findAgyBinary(customPath) {
  const explicit = customPath || process.env.AGY_CLI_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`AGY_CLI_PATH not found: ${explicit}`);
    return explicit;
  }

  const pathResult = runSync("agy", ["--version"], 10000);
  if (pathResult.status === 0) {
    if (process.platform === "win32") {
      const where = runSync("where", ["agy"], 5000);
      if (where.status === 0) {
        const best = pickWhereBest(where.stdout.toString().trim().split("\n"));
        if (best) return best;
      }
    }
    return "agy";
  }

  for (const c of agyCandidates()) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    "Antigravity CLI (agy) not found. Install agy or set AGY_CLI_PATH."
  );
}

export async function findAgyBinaryAsync(customPath) {
  const explicit = customPath || process.env.AGY_CLI_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`AGY_CLI_PATH not found: ${explicit}`);
    return explicit;
  }

  const pathResult = await runAsync("agy", ["--version"], 10000);
  if (pathResult.status === 0) {
    if (process.platform === "win32") {
      const where = await runAsync("where", ["agy"], 5000);
      if (where.status === 0) {
        const best = pickWhereBest(where.stdout.trim().split("\n"));
        if (best) return best;
      }
    }
    return "agy";
  }

  for (const c of agyCandidates()) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    "Antigravity CLI (agy) not found. Install agy or set AGY_CLI_PATH."
  );
}

export function checkAgyStatus(agyPath) {
  let bin;
  try {
    bin = agyPath || findAgyBinary();
  } catch (e) {
    return { installed: false, authenticated: false, models: [], error: e.message };
  }
  if (agyPath && !fs.existsSync(agyPath) && (path.isAbsolute(agyPath) || /[\\/]/.test(agyPath))) {
    return { installed: false, authenticated: false, models: [], error: `agy binary not found: ${agyPath}` };
  }

  const version = runSync(bin, ["--version"], 10000);
  if (version.error || version.status !== 0) {
    const detail = version.error
      ? version.error.message
      : version.stderr?.toString().trim() || `exited with status ${version.status}`;
    return { installed: false, authenticated: false, models: [], error: detail };
  }

  const modelsRes = runSync(bin, ["models"], 15000);
  const models = modelsRes.status === 0 ? parseAgyModels(modelsRes.stdout.toString()) : [];
  const authenticated = modelsRes.status === 0 && models.length > 0;

  return {
    installed: true,
    path: bin,
    version: version.stdout.toString().trim(),
    authenticated,
    models,
    ...(modelsRes.status !== 0 ? { error: modelsRes.stderr?.toString().trim() || `agy models exited ${modelsRes.status}` } : {}),
  };
}

export async function checkAgyStatusAsync(agyPath) {
  let bin;
  try {
    bin = agyPath || await findAgyBinaryAsync();
  } catch (e) {
    return { installed: false, authenticated: false, models: [], error: e.message };
  }
  if (agyPath && !fs.existsSync(agyPath) && (path.isAbsolute(agyPath) || /[\\/]/.test(agyPath))) {
    return { installed: false, authenticated: false, models: [], error: `agy binary not found: ${agyPath}` };
  }

  const version = await runAsync(bin, ["--version"], 10000);
  if (version.status !== 0) {
    const detail = version.error?.message || version.stderr?.trim() || `exited with status ${version.status}`;
    return { installed: false, authenticated: false, models: [], error: detail };
  }

  const modelsRes = await runAsync(bin, ["models"], 15000);
  const models = modelsRes.status === 0 ? parseAgyModels(modelsRes.stdout) : [];
  const authenticated = modelsRes.status === 0 && models.length > 0;

  return {
    installed: true,
    path: bin,
    version: version.stdout.trim(),
    authenticated,
    models,
    ...(modelsRes.status !== 0 ? { error: modelsRes.stderr?.trim() || `agy models exited ${modelsRes.status}` } : {}),
  };
}
