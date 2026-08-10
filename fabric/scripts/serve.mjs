#!/usr/bin/env node
// scripts/serve.mjs — bring this machine UP as a fabric member, in THIS terminal: the LAN
// node server AND the management console, in ONE process.
//
//   node scripts/serve.mjs [--port N] [--console-port N] [--no-console] [--status]
//
// Reads the `fabric` block of claude_env_settings.json (token/tokens, serve.{port,host,
// name,projects,maxSessions}) and exposes node/spawn|send|close|status|ping to peer fabric
// nodes. Peers reference projects by the aliases registered here — pure message-passing,
// no shared filesystem.
//
// Both components are idempotent (an already-running instance is detected and skipped) and
// both die with this terminal — never a background service, by directive.

import { hostname } from "node:os";
import { createNodeServer, pluginVersion } from "../engine/node-server.mjs";
import { loadServeConfig, loadFabricConfig } from "../engine/node-config.mjs";
import { getConfigPath } from "../engine/providers.mjs";
import { setJournalOwnerKind } from "../engine/session.mjs";
import { startConsole, consoleAlreadyServing } from "../web/server.mjs";

// Journal ownership (SR-045): a session spawned through this process belongs to the SERVE
// daemon, not to a library caller. The default 'lib' would misattribute every peer-driven
// and console-driven session — exactly the multi-process case the owner fact exists to
// disambiguate. Set before anything can spawn, so no event can be journaled unowned.
setJournalOwnerKind("serve");

const serve = loadServeConfig(); // serve defaults + this hostname's byHost override
const token = serve.token;
if (!token) {
  process.stderr.write(`fabric serve: no token configured. Set "fabric": { "token": "..." } in ${getConfigPath()}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
/** Read a --flag N port, validating it; `dflt` when the flag is absent. */
function portFlag(name, dflt) {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const port = Number(args[i + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`fabric serve: ${name} requires a port number 1-65535, got "${args[i + 1] ?? ""}"\n`);
    process.exit(1);
  }
  return port;
}

const port = portFlag("--port", serve.port ?? 7677);
const consolePort = portFlag("--console-port", serve.consolePort ?? 7678);
const wantConsole = !args.includes("--no-console");
const name = serve.name || hostname();
const projects = serve.projects || {};
const tags = serve.tags || [];

// --status: report the resolved config and whether a node is already serving this port,
// then exit. Read-only; the probe is the same node/status a peer would issue.
if (args.includes("--status")) {
  const { connectNode } = await import("../engine/node-client.mjs");
  process.stdout.write(`name: ${name}\nversion: ${pluginVersion()} (this checkout)\nport: ${port}\nprojects: ${Object.keys(projects).join(", ") || "(none)"}\ntags: ${tags.join(", ") || "(none)"}\n`);
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token, connectTimeoutMs: 2000 });
    const st = await conn.request("node/status", {}, { timeoutMs: 5000 });
    conn.close();
    process.stdout.write(`serving: yes (version ${st.version}, up ${st.uptime_s}s, ${st.sessions_count} session(s) of max ${st.maxSessions}, ${st.mem_available_mb} MB free)\n`);
  } catch (e) {
    // Only a REFUSED connection proves nothing is serving. A timeout, a TLS/PSK mismatch
    // or a rejected token all mean "something is there and we could not talk to it" —
    // which is exactly the case you run this diagnostic for (SR-014).
    if (e.code === "ECONNREFUSED") {
      process.stdout.write("serving: no (connection refused — nothing is listening on this port)\n");
    } else {
      process.stdout.write(`serving: unknown (${e.code ?? "no code"}: ${e.message})\n`);
    }
  }
  process.stdout.write(`console: ${await consoleAlreadyServing(consolePort) ? `yes (http://127.0.0.1:${consolePort})` : "no"}\n`);
  process.exit(0);
}

// ── 1. LAN node server (idempotent) ──
const fabricCfg = loadFabricConfig();
const server = createNodeServer({
  token, tokens: serve.tokens || [], name, projects, tags,
  profiles: fabricCfg.profiles || {}, defaultProfile: serve.defaultProfile ?? null,
  ...(serve.maxSessions != null ? { maxSessions: serve.maxSessions } : {}),
});

// Idempotent start: a second serve on the same port detects the live one and exits 0
// (previously a bare EADDRINUSE crash). Lifecycle stays session-bound: the server dies
// with this terminal, and ONLY a fabric node answering our token counts as "already up".
let bound = null;
try {
  bound = await server.listen(port, serve.host || "0.0.0.0");
} catch (e) {
  if (e.code !== "EADDRINUSE") throw e;
  try {
    const { connectNode } = await import("../engine/node-client.mjs");
    const conn = await connectNode({ host: "127.0.0.1", port, token, connectTimeoutMs: 2000 });
    const st = await conn.request("node/status", {}, { timeoutMs: 5000 });
    conn.close();
    process.stdout.write(`fabric node "${st.name}" already serving on port ${port} (v${st.version}, up ${st.uptime_s}s) — skipped\n`);
  } catch {
    process.stderr.write(`fabric serve: port ${port} is taken by something that is NOT a fabric node with this token\n`);
    process.exit(1);
  }
}
if (bound) {
  const aliases = Object.keys(projects).join(", ") || "(none — peers can only spawn in this cwd)";
  // Version on the banner: the operator's one-glance check that a restart actually
  // loaded the new code (peers see the same figure via node/status and ping.mjs).
  process.stdout.write(`fabric node "${name}" v${pluginVersion()} listening on port ${bound.port}; projects: ${aliases}\n`);
}

// ── 2. Management console (idempotent, --no-console to skip) ──
if (wantConsole) {
  try {
    await startConsole({ port: consolePort });
    process.stdout.write(`fabric console: http://127.0.0.1:${consolePort}\n`);
  } catch (e) {
    if (e.code === "EADDRINUSE" && await consoleAlreadyServing(consolePort)) {
      process.stdout.write(`fabric console already serving on http://127.0.0.1:${consolePort} — skipped\n`);
    } else {
      process.stderr.write(`fabric serve: console failed: ${e.message}\n`);
      process.exit(1);
    }
  }
}

// ── 3. Crash-recovery reminder (2026-08-10) ──
// A previous serve may have died leaving session children running (or conversations
// resumable). The journal knows; the OPERATOR decides — this is the reminder the
// design's "kill-or-adopt is the layer above's decision" promised.
try {
  const { reconcile } = await import("../engine/journal.mjs");
  const orphans = reconcile().filter((o) => o.pidAlive !== false);
  if (orphans.length) {
    process.stdout.write("\n⚠ " + orphans.length + " session(s) survived a previous serve run — decide what to do:\n");
    for (const o of orphans) {
      process.stdout.write(
        `   ${o.id}  ${o.provider ?? "?"}  pid ${o.pid ?? "—"}  ` +
        `${o.pidAlive === null ? "alive UNKNOWN (remote)" : "alive"}${o.sessionId ? "  resumable" : ""}  ` +
        `spawned ${new Date(o.ts).toLocaleString()}\n`,
      );
    }
    process.stdout.write(
      "   → Management console: continue (resume the conversation) or kill each session.\n" +
      "   → `serve --status` also lists them; the journal keeps the records either way.\n\n",
    );
  }
} catch { /* journal unreadable: no recovery report — records stay on disk regardless */ }

process.stdout.write(`fabric serve: close this terminal to stop ${wantConsole ? "both" : "the node"}.\n`);

// server.close() reaps every session child (they are windowsHide — invisible orphans
// otherwise). SIGHUP is what Windows delivers when the terminal window is closed with X
// (CTRL_CLOSE_EVENT, ~5s budget — the 3s close grace fits inside it).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => { await server.close(); process.exit(0); });
}
