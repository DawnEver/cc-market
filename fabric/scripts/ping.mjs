#!/usr/bin/env node
// scripts/ping.mjs — probe every configured fabric node and print its capacity facts.
//
//   node scripts/ping.mjs [node ...]
//
// One line per node: ALIVE with {version, uptime, cpu, free memory, sessions} or DEAD
// with the reason. Exit 0 if every probed node answered, 1 otherwise. This is the
// hand-written 2026-08-09 probe promoted to a built-in (G1).

import { loadFabricConfig } from "../engine/node-config.mjs";
import { connectNode } from "../engine/node-client.mjs";

const fc = loadFabricConfig();
const wanted = process.argv.slice(2);
const entries = Object.entries(fc.nodes || {}).filter(([n]) => !wanted.length || wanted.includes(n));
if (!entries.length) {
  process.stderr.write(wanted.length
    ? `fabric ping: no configured node matches: ${wanted.join(", ")}\n`
    : "fabric ping: no fabric nodes configured (fabric.nodes in claude_env_settings.json)\n");
  process.exit(1);
}

let dead = 0;
for (const [name, n] of entries) {
  try {
    const conn = await connectNode({ host: n.host, port: n.port, token: n.token || fc.token, connectTimeoutMs: 4000 });
    const st = await conn.request("node/status", {});
    conn.close();
    process.stdout.write(`${name} ALIVE v${st.version} up=${st.uptime_s}s cpu=${st.cpu} free=${st.mem_available_mb}MB sessions=${st.sessions.length}${st.tags?.length ? ` tags=${st.tags.join(",")}` : ""}\n`);
  } catch (e) {
    dead++;
    process.stdout.write(`${name} DEAD ${String(e.message).slice(0, 120)}\n`);
  }
}
process.exit(dead ? 1 : 0);
