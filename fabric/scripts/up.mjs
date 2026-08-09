#!/usr/bin/env node
// scripts/up.mjs — bring this machine UP as a fabric member: the LAN node server AND
// the management console, in ONE process, in THIS terminal.
//
//   node scripts/up.mjs [--port N] [--console-port N]
//
// Both components are idempotent (an already-running instance is detected and skipped)
// and both die with this terminal — never a background service, by directive.

import { hostname } from "node:os";
import { createNodeServer } from "../engine/node-server.mjs";
import { loadServeConfig, loadFabricConfig } from "../engine/node-config.mjs";
import { connectNode } from "../engine/node-client.mjs";
import { startConsole, consoleAlreadyServing } from "../web/server.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 ? Number(args[i + 1]) : dflt;
};

// ── 1. LAN node server (idempotent) ──
const serve = loadServeConfig();
const port = flag("--port", serve.port ?? 7677);
if (!serve.token) {
  process.stderr.write("fabric up: no token configured (fabric.token in claude_env_settings.json)\n");
  process.exit(1);
}
const name = serve.name || hostname();
try {
  const fabricCfg = loadFabricConfig();
  const server = createNodeServer({
    token: serve.token, name, projects: serve.projects || {}, tags: serve.tags || [],
    profiles: fabricCfg.profiles || {}, defaultProfile: serve.defaultProfile ?? null,
  });
  const bound = await server.listen(port, serve.host || "0.0.0.0");
  process.stdout.write(`fabric node "${name}" listening on port ${bound.port}; projects: ${Object.keys(serve.projects || {}).join(", ") || "(none)"}\n`);
} catch (e) {
  if (e.code !== "EADDRINUSE") throw e;
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: serve.token, connectTimeoutMs: 2000 });
    const st = await conn.request("node/status", {});
    conn.close();
    process.stdout.write(`fabric node "${st.name}" already serving on port ${port} (v${st.version}, up ${st.uptime_s}s) — skipped\n`);
  } catch {
    process.stderr.write(`fabric up: port ${port} is taken by something that is NOT a fabric node with this token\n`);
    process.exit(1);
  }
}

// ── 2. Management console (idempotent) ──
const consolePort = flag("--console-port", 7678);
try {
  await startConsole({ port: consolePort });
  process.stdout.write(`fabric console: http://127.0.0.1:${consolePort}\n`);
} catch (e) {
  if (e.code === "EADDRINUSE" && await consoleAlreadyServing(consolePort)) {
    process.stdout.write(`fabric console already serving on http://127.0.0.1:${consolePort} — skipped\n`);
  } else {
    process.stderr.write(`fabric up: console failed: ${e.message}\n`);
    process.exit(1);
  }
}

process.stdout.write("fabric up: close this terminal to stop both.\n");
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
