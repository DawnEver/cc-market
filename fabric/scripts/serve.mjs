#!/usr/bin/env node
// scripts/serve.mjs — run this machine as a fabric LAN node.
//
//   node scripts/serve.mjs [--port N]
//
// Reads the `fabric` block of claude_env_settings.json (token, serve.{port,host,name,projects})
// and exposes node/spawn|send|close|status to peer fabric nodes. Peers reference projects by
// the aliases registered here — pure message-passing, no shared filesystem.

import { hostname } from "node:os";
import { createNodeServer } from "../engine/node-server.mjs";
import { loadServeConfig, loadFabricConfig } from "../engine/node-config.mjs";
import { getConfigPath } from "../engine/providers.mjs";

const serve = loadServeConfig(); // serve defaults + this hostname's byHost override
const token = serve.token;
if (!token) {
  process.stderr.write(`fabric serve: no token configured. Set "fabric": { "token": "..." } in ${getConfigPath()}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
let port = serve.port ?? 7677;
if (portFlag !== -1) {
  port = Number(args[portFlag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`fabric serve: --port requires a port number 1-65535, got "${args[portFlag + 1] ?? ""}"\n`);
    process.exit(1);
  }
}
const name = serve.name || hostname();
const projects = serve.projects || {};
const tags = serve.tags || [];

// --status: report the resolved config and whether a node is already serving this port,
// then exit. Read-only; the probe is the same node/status a peer would issue.
if (args.includes("--status")) {
  const { connectNode } = await import("../engine/node-client.mjs");
  process.stdout.write(`name: ${name}\nport: ${port}\nprojects: ${Object.keys(projects).join(", ") || "(none)"}\ntags: ${tags.join(", ") || "(none)"}\n`);
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token, connectTimeoutMs: 2000 });
    const st = await conn.request("node/status", {});
    conn.close();
    process.stdout.write(`serving: yes (version ${st.version}, up ${st.uptime_s}s, ${st.sessions.length} session(s), ${st.mem_available_mb} MB free)\n`);
  } catch {
    process.stdout.write("serving: no (nothing answered on this port)\n");
  }
  process.exit(0);
}

const fabricCfg = loadFabricConfig();
const server = createNodeServer({
  token, name, projects, tags,
  profiles: fabricCfg.profiles || {}, defaultProfile: serve.defaultProfile ?? null,
});

// Idempotent start: a second serve on the same port detects the live one and exits 0
// (previously a bare EADDRINUSE crash). Lifecycle stays session-bound: the server dies
// with this terminal, and ONLY a fabric node answering our token counts as "already up".
let bound;
try {
  bound = await server.listen(port, serve.host || "0.0.0.0");
} catch (e) {
  if (e.code !== "EADDRINUSE") throw e;
  try {
    const { connectNode } = await import("../engine/node-client.mjs");
    const conn = await connectNode({ host: "127.0.0.1", port, token, connectTimeoutMs: 2000 });
    const st = await conn.request("node/status", {});
    conn.close();
    process.stdout.write(`fabric node "${st.name}" already serving on port ${port} (v${st.version}, up ${st.uptime_s}s) — nothing to do
`);
    process.exit(0);
  } catch {
    process.stderr.write(`fabric serve: port ${port} is taken by something that is NOT a fabric node with this token
`);
    process.exit(1);
  }
}
const aliases = Object.keys(projects).join(", ") || "(none — peers can only spawn in this cwd)";
process.stdout.write(`fabric node "${name}" listening on port ${bound.port}; projects: ${aliases}\n`);

process.on("SIGINT", async () => { await server.close(); process.exit(0); });
process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
