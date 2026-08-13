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
const { loadOrCreateIdentity } = await import("../engine/node-identity.mjs");
const { createMesh } = await import("../engine/node-mesh.mjs");
// P3: ONE identity per machine, loaded before the server starts so every inbound edge
// can prove it. The fingerprint is the node's public name; the key never leaves the box.
const identity = loadOrCreateIdentity();
// P1/P2: the mesh keeper maintains one symmetric edge per configured peer. It is wired
// into the server by closure (getMesh/onEdge) because the server must exist first.
let mesh = null;
const server = createNodeServer({
  token, tokens: serve.tokens || [], name, projects, tags,
  profiles: fabricCfg.profiles || {}, defaultProfile: serve.defaultProfile ?? null,
  // A peer may omit provider/model/effort on node/spawn and inherit this node's default.
  sessionDefaults: fabricCfg.sessionDefaults || null,
  identity,
  getMesh: () => mesh,
  onEdge: (edge) => mesh?.adoptInbound(edge),
  // Config-pinned fingerprints (fabric.nodes.<name>.fingerprint) gate inbound hellos;
  // unpinned peers fall back to TOFU inside trustPeer.
  peerPins: () => Object.fromEntries(
    Object.entries(loadFabricConfig().nodes || {})
      .filter(([, n]) => n.fingerprint).map(([n, spec]) => [n, spec.fingerprint])),
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
  process.stdout.write(`fabric identity: ${identity.fingerprint} (pin this in fabric.nodes."${name}".fingerprint on every peer)\n`);

  // ── 1b. Mesh keeper (P1/P2): hold one symmetric edge to every configured peer. Dial
  // direction is decided by who CAN connect; a peer that can only be reached BY us ends
  // up as our outbound edge, and its consoles reach us back over the same socket.
  mesh = createMesh({
    name, identity,
    // Requests arriving on our OUTBOUND edges (the peer asking back over the socket we
    // dialed) are served by the same auth+dispatch as inbound sockets.
    onRequest: (m, p) => server.serveRequest(m, p),
    nodes: () => {
      const cfg = loadFabricConfig();
      const out = {};
      for (const [n, spec] of Object.entries(cfg.nodes || {})) {
        if (n === name) continue;
        out[n] = { host: spec.host, port: spec.port, token: spec.token || cfg.token, fingerprint: spec.fingerprint ?? null };
      }
      return out;
    },
  });
  mesh.start();
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

// ── 3. Journal housekeeping + crash-recovery reminder (2026-08-10) ──
// Fold the history first: every OTHER file's writer is dead by now (boot time is the
// only safe moment — folding must not race a live writer), so settled sessions drop
// and history collapses to O(open sessions) + the fresh live file.
try {
  const { compactJournal } = await import("../engine/journal.mjs");
  const folded = compactJournal();
  if (folded.files > 0) {
    process.stdout.write(`fabric serve: journal folded (${folded.files} file(s); kept ${folded.kept} open-session event(s), dropped ${folded.dropped} settled)\n`);
  }
} catch { /* folding is best-effort — the journal stays readable either way */ }

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
  process.on(sig, async () => { mesh?.stop(); await server.close(); process.exit(0); });
}
