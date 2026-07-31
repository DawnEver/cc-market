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
import { loadServeConfig } from "../engine/node-config.mjs";
import { getConfigPath } from "../engine/providers.mjs";

const serve = loadServeConfig(); // serve defaults + this hostname's byHost override
const token = serve.token;
if (!token) {
  process.stderr.write(`fabric serve: no token configured. Set "fabric": { "token": "..." } in ${getConfigPath()}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : (serve.port ?? 7677);
const name = serve.name || hostname();
const projects = serve.projects || {};

const server = createNodeServer({ token, name, projects });
const bound = await server.listen(port, serve.host || "0.0.0.0");
const aliases = Object.keys(projects).join(", ") || "(none — peers can only spawn in this cwd)";
process.stdout.write(`fabric node "${name}" listening on port ${bound.port}; projects: ${aliases}\n`);

process.on("SIGINT", async () => { await server.close(); process.exit(0); });
process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
