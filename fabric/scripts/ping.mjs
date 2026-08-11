#!/usr/bin/env node
// scripts/ping.mjs — probe every configured fabric node and print its capacity facts.
//
//   node scripts/ping.mjs [node ...]
//
// One line per node: ALIVE with {version, uptime, cpu, free memory, sessions} or DEAD
// with the reason. Exit 0 if every probed node answered, 1 otherwise. This is the
// hand-written 2026-08-09 probe promoted to a built-in (G1).
//
// Every node is probed CONCURRENTLY and carries its OWN deadline (SR-004/043): serially,
// one wedged node delayed the whole report by its timeout, and a node that accepted the
// connection and then went silent delayed it forever.

import { loadFabricConfig } from "../engine/node-config.mjs";
import { connectNode } from "../engine/node-client.mjs";
import { fmtUptime, fmtMem } from "./lib/format.mjs";

const CONNECT_TIMEOUT_MS = Number(process.env.FABRIC_PING_TIMEOUT_MS) || 4000;
const REQUEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS;

const fc = loadFabricConfig();
const wanted = process.argv.slice(2);
const entries = Object.entries(fc.nodes || {}).filter(([n]) => !wanted.length || wanted.includes(n));
if (!entries.length) {
  process.stderr.write(wanted.length
    ? `fabric ping: no configured node matches: ${wanted.join(", ")}\n`
    : "fabric ping: no fabric nodes configured (fabric.nodes in claude_env_settings.json)\n");
  process.exit(1);
}

async function probe([name, n]) {
  let conn = null;
  try {
    conn = await connectNode({
      host: n.host, port: n.port, token: n.token || fc.token, connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    // `light`: this report prints counts, never per-session usage.
    const st = await conn.request("node/status", { detail: "light" }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return `${name} ALIVE v${st.version} up=${fmtUptime(st.uptime_s)} cpu=${st.cpu_busy_pct ?? "?"}% (${st.cpu} cores) `
      + `mem=${fmtMem(st.mem_available_mb)}/${fmtMem(st.mem_total_mb)} `
      + `sessions=${st.sessions_count ?? st.sessions.length}/${st.maxSessions ?? "?"}`
      + `${st.tags?.length ? ` tags=${st.tags.join(",")}` : ""}\n`;
  } finally { conn?.close(); }
}

// A TLS/PSK failure's message IS the diagnostic ("wrong version number", "unknown psk
// identity"); truncating it to 120 chars used to cut off the part that named the cause.
const reason = (e) => `${e.code ? `${e.code}: ` : ""}${String(e.message).slice(0, 300)}`;

const results = await Promise.allSettled(entries.map(probe));
let dead = 0;
results.forEach((r, i) => {
  if (r.status === "fulfilled") process.stdout.write(r.value);
  else { dead++; process.stdout.write(`${entries[i][0]} DEAD ${reason(r.reason)}\n`); }
});
process.exit(dead ? 1 : 0);
