// tests/node-fabric.test.mjs — LAN node fabric: server auth, spawn/send/close roundtrip,
// project alias resolution, remote session handle, connection-loss rejection, config loading.
// All over real localhost sockets with injected fake provider sessions — no real providers.

// Isolate the session journal: registry events must never pollute the user's real ~/.fabric.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-test-'));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import tls from "node:tls";
import net from "node:net";
import { PSK_IDENTITY, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken, identityForToken, MAX_LINE_BYTES } from "../engine/node-tls.mjs";

import { createNodeServer, AUTH_ERROR } from "../engine/node-server.mjs";
import { connectNode, openRemoteSession, attachRemoteSession, poolStats, _setPoolHeartbeatMs } from "../engine/node-client.mjs";
import { loadFabricConfig, resolveNode, loadServeConfig, resolveSystemPromptFile } from "../engine/node-config.mjs";
import { openProviderSession, createTeam, sendToTeamWorker, closeTeam, _resetRegistry } from "../engine/session.mjs";

const TOKEN = "test-secret";

// Fake session backend: echo provider, records opts.
function fakeSessionDeps() {
  const opened = [];
  const sessions = new Map();
  let seq = 0;
  return {
    opened,
    createSession: async (opts) => {
      opened.push(opts);
      const id = `sess-fake-${++seq}`;
      sessions.set(id, { turns: 0, provider: opts.provider });
      return { id, provider: opts.provider, nativeId: null };
    },
    sendToSession: async (id, text) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`No such session: ${id}`);
      s.turns++;
      return { text: `echo:${text}`, turn: s.turns };
    },
    closeSession: async (id) => {
      if (!sessions.delete(id)) throw new Error(`No such session: ${id}`);
      return { id, exitCode: 0 };
    },
    compactSession: async (id) => {
      if (!sessions.has(id)) throw new Error(`No such session: ${id}`);
      return { id, provider: sessions.get(id).provider, compacted: true, confirmed: true };
    },
    setSessionGoal: async (id, condition) => {
      if (!sessions.has(id)) throw new Error(`No such session: ${id}`);
      return { id, provider: sessions.get(id).provider, condition, active: true };
    },
    goalRunSession: async (id, opts) => {
      if (!sessions.has(id)) throw new Error(`No such session: ${id}`);
      return { id, provider: sessions.get(id).provider, text: `goal:${opts.prompt}`, turns: 3, state: 'met' };
    },
    listSessions: () => [...sessions.entries()].map(([id, s]) => ({ id, provider: s.provider, turns: s.turns })),
    viewSession: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`No such session: ${id}`);
      return { id, provider: s.provider, content: `transcript:${id}`, alive: true, turns: s.turns };
    },
  };
}

// Raw TLS-PSK socket for wire-level tests (bypasses connectNode's request framing).
function tlsRaw(port, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: "127.0.0.1", port,
      pskCallback: () => ({ psk: pskFromToken(token), identity: PSK_IDENTITY }),
      ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
      checkServerIdentity: () => undefined,
    });
    sock.once("secureConnect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function startServer(extra = {}) {
  const deps = fakeSessionDeps();
  // cpuSampleMs:0 skips the ~120ms CPU sample on status calls (most tests don't need it);
  // a test that asserts a real cpu_busy_pct passes its own cpuSampleMs via `extra`.
  const server = createNodeServer({ token: TOKEN, name: "testnode", cpuSampleMs: 0, deps, ...extra });
  const { port } = await server.listen(0, "127.0.0.1");
  return { server, deps, port };
}

test("createNodeServer refuses to start without a token", () => {
  assert.throws(() => createNodeServer({}), /token/);
});

test("a wrong token fails the TLS-PSK handshake outright", async () => {
  const { server, port } = await startServer();
  try {
    await assert.rejects(() => connectNode({ host: "127.0.0.1", port, token: "wrong" }));
  } finally { await server.close(); }
});

test("request-level bad token still gets AUTH_ERROR (defense in depth)", async () => {
  const { server, port } = await startServer();
  try {
    // Correct PSK (handshake passes) but a bad params.token on the request itself.
    const sock = await tlsRaw(port);
    let received = "";
    sock.on("data", (c) => { received += c; });
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node/status", params: { token: "bad" } })}\n`);
    for (let i = 0; i < 100 && !received.includes("\n"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(JSON.parse(received.split("\n")[0]).error.code, AUTH_ERROR);
    sock.destroy();
  } finally { await server.close(); }
});

test("status / spawn / send / close roundtrip", async () => {
  const { server, deps, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const status = await conn.request("node/status", {});
    assert.equal(status.name, "testnode");
    // Capacity facts (G1): cores, CPU busy %, memory free/total, uptime, hostname.
    assert.equal(typeof status.hostname, "string");
    assert.ok(Number.isInteger(status.cpu) && status.cpu > 0);
    assert.equal(status.cpu_busy_pct, null, "cpuSampleMs:0 opts out of the CPU sample");
    assert.ok(status.mem_available_mb > 0 && status.mem_total_mb > 0);
    assert.ok(Number.isInteger(status.uptime_s) && status.uptime_s >= 0);
    assert.equal(typeof status.version, "string");
    assert.deepEqual(status.sessions, []);

    const desc = await conn.request("node/spawn", { provider: "deepseek" });
    assert.ok(desc.id);
    assert.equal(desc.provider, "deepseek");

    const r1 = await conn.request("node/send", { id: desc.id, prompt: "hello" });
    assert.equal(r1.text, "echo:hello");
    assert.equal(r1.turn, 1);

    const closed = await conn.request("node/close", { id: desc.id });
    assert.equal(closed.exitCode, 0);
    assert.equal(deps.listSessions().length, 0);
    conn.close();
  } finally { await server.close(); }
});

test("concurrent sends multiplex on one connection", async () => {
  const { server, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const a = await conn.request("node/spawn", { provider: "a" });
    const b = await conn.request("node/spawn", { provider: "b" });
    const [ra, rb] = await Promise.all([
      conn.request("node/send", { id: a.id, prompt: "one" }),
      conn.request("node/send", { id: b.id, prompt: "two" }),
    ]);
    assert.equal(ra.text, "echo:one");
    assert.equal(rb.text, "echo:two");
    conn.close();
  } finally { await server.close(); }
});

test("project alias resolves to configured cwd; unknown alias errors", async () => {
  const { server, deps, port } = await startServer({ projects: { thesis: "/data/thesis" } });
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await conn.request("node/spawn", { provider: "x", project: "thesis" });
    assert.equal(deps.opened[0].cwd, "/data/thesis");
    await assert.rejects(() => conn.request("node/spawn", { provider: "x", project: "nope" }), /unknown project/i);
    conn.close();
  } finally { await server.close(); }
});

test("openRemoteSession returns a uniform {id, send, close} handle", async () => {
  const { server, deps, port } = await startServer({ projects: { p: "/p" } });
  try {
    const handle = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "deepseek", project: "p" });
    assert.ok(handle.id);
    const r = await handle.send("hi");
    assert.equal(r.text, "echo:hi");
    assert.equal(r.turn, 1);
    const code = await handle.close();
    assert.equal(code, 0);
    assert.equal(deps.listSessions().length, 0);
  } finally { await server.close(); }
});

test("pending requests reject when the connection drops", async () => {
  // A send that never resolves keeps a request pending; killing the server must reject it.
  const deps = fakeSessionDeps();
  deps.sendToSession = () => new Promise(() => {});
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
  const desc = await conn.request("node/spawn", { provider: "x" });
  const hanging = conn.request("node/send", { id: desc.id, prompt: "never answered" });
  await server.close(); // destroys the socket mid-request
  await assert.rejects(() => hanging, /connection/i);
});

test("malformed JSON on the wire does not kill the server", async () => {
  const { server, port } = await startServer();
  try {
    const sock = await tlsRaw(port);
    sock.write("this is not json\n");
    sock.end();
    // Server must still answer a well-formed client afterwards.
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const status = await conn.request("node/status", {});
    assert.equal(status.name, "testnode");
    conn.close();
  } finally { await server.close(); }
});

test("openProviderSession routes opts.node to the remote node (name resolved from config)", async () => {
  const { server, port } = await startServer();
  const dir = mkdtempSync(join(tmpdir(), "fabric-route-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({
    fabric: { token: TOKEN, nodes: { peer: { host: "127.0.0.1", port } } },
  }));
  const prevEnv = process.env.CC_MARKET_CONFIG_PATH;
  process.env.CC_MARKET_CONFIG_PATH = cfgPath;
  try {
    const handle = await openProviderSession({ provider: "deepseek", node: "peer" });
    const r = await handle.send("ping");
    assert.equal(r.text, "echo:ping");
    await handle.close();
  } finally {
    if (prevEnv === undefined) delete process.env.CC_MARKET_CONFIG_PATH;
    else process.env.CC_MARKET_CONFIG_PATH = prevEnv;
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("a team can mix in remote workers ({host,port,token} node spec)", async () => {
  const { server, port } = await startServer({ projects: { repo: "/r" } });
  _resetRegistry();
  try {
    const node = { host: "127.0.0.1", port, token: TOKEN };
    const team = await createTeam([
      { id: "remote-1", provider: "deepseek", node, project: "repo" },
    ]);
    assert.equal(team.workers[0].node, node);
    const r = await sendToTeamWorker(team.teamId, "remote-1", "task please");
    assert.equal(r.text, "echo:task please");
    await closeTeam(team.teamId);
  } finally {
    _resetRegistry();
    await server.close();
  }
});

test("node host may be a DNS name, not just an IP", async () => {
  const { server, port } = await startServer();
  try {
    // "localhost" exercises the DNS-resolution path in net.connect — same as an AD FQDN.
    const handle = await openRemoteSession({ host: "localhost", port, token: TOKEN, provider: "x" });
    const r = await handle.send("dns");
    assert.equal(r.text, "echo:dns");
    await handle.close();
  } finally { await server.close(); }
});

test("loadServeConfig merges the matching byHost override (case-insensitive, FQDN or short)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-servecfg-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({
    fabric: {
      token: "shared",
      serve: {
        port: 7677,
        projects: { common: "/common", thesis: "/default/thesis" },
        byHost: {
          "HOST-A": { port: 8000, projects: { thesis: "D:/repos/thesis" } },
          "mac.local": { name: "mac" },
        },
      },
    },
  }));
  try {
    // FQDN hostname matches the short byHost key, case-insensitively.
    const s = loadServeConfig(cfgPath, "host-a.example.corp");
    assert.equal(s.port, 8000);
    assert.equal(s.projects.thesis, "D:/repos/thesis"); // override wins
    assert.equal(s.projects.common, "/common");         // base aliases survive the merge
    assert.equal(s.token, "shared");                    // falls back to fabric.token

    const mac = loadServeConfig(cfgPath, "MAC");
    assert.equal(mac.name, "mac");
    assert.equal(mac.port, 7677);

    const other = loadServeConfig(cfgPath, "unknown-box");
    assert.equal(other.port, 7677);
    assert.equal(other.projects.thesis, "/default/thesis");
    assert.equal(other.byHost, undefined); // byHost itself never leaks into the result
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadFabricConfig + resolveNode read the fabric block", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-nodecfg-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({
    "env:deepseek": {},
    fabric: {
      token: "shared",
      nodes: { desktop: { host: "10.0.0.2", port: 7677 }, mac: { host: "10.0.0.3", port: 7677, token: "own" } },
    },
  }));
  try {
    const fab = loadFabricConfig(cfgPath);
    assert.equal(fab.token, "shared");
    const d = resolveNode("desktop", cfgPath);
    assert.equal(d.host, "10.0.0.2");
    assert.equal(d.token, "shared"); // inherits fabric.token
    const m = resolveNode("mac", cfgPath);
    assert.equal(m.token, "own"); // per-node override wins
    assert.throws(() => resolveNode("ghost", cfgPath), /ghost/);
    assert.deepEqual(loadFabricConfig(join(dir, "missing.json")), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- session ownership (SR-001/SR-010) ---

test("node/send and node/close reject session ids not owned by the connection", async () => {
  const { server, port } = await startServer();
  try {
    const owner = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const other = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await owner.request("node/spawn", { provider: "x" });
    await assert.rejects(() => other.request("node/send", { id: desc.id, prompt: "hi" }), (e) => e.code === -32602);
    await assert.rejects(() => other.request("node/close", { id: desc.id }), (e) => e.code === -32602);
    // status still lists everyone's sessions; the owner can still drive its own.
    const status = await other.request("node/status", {});
    assert.equal(status.sessions.length, 1);
    assert.equal((await owner.request("node/send", { id: desc.id, prompt: "hi" })).text, "echo:hi");
    await owner.request("node/close", { id: desc.id });
    owner.close(); other.close();
  } finally { await server.close(); }
});

test("sessions spawned on a connection are closed when its socket drops", async () => {
  const { server, deps, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await conn.request("node/spawn", { provider: "a" });
    await conn.request("node/spawn", { provider: "b" });
    assert.equal(deps.listSessions().length, 2);
    conn.close();
    // best-effort reap is async: poll briefly.
    for (let i = 0; i < 50 && deps.listSessions().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(deps.listSessions().length, 0);
  } finally { await server.close(); }
});

// --- JSON-RPC error codes (SR-003) ---

test("dispatch errors carry proper JSON-RPC codes", async () => {
  const deps = fakeSessionDeps();
  deps.sendToSession = async () => { throw new Error("provider exploded"); };
  const server = createNodeServer({ token: TOKEN, name: "t", deps, projects: {} });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(() => conn.request("node/frobnicate", {}), (e) => e.code === -32601);
    await assert.rejects(() => conn.request("node/spawn", {}), (e) => e.code === -32602);
    await assert.rejects(() => conn.request("node/send", { id: "s" }), (e) => e.code === -32602);
    await assert.rejects(() => conn.request("node/spawn", { provider: "x", project: "nope" }), (e) => e.code === -32602);
    const desc = await conn.request("node/spawn", { provider: "x" });
    await assert.rejects(() => conn.request("node/send", { id: desc.id, prompt: "p" }),
      (e) => e.code === -32000 && /provider exploded/.test(e.message)); // runtime failure stays -32000
    conn.close();
  } finally { await server.close(); }
});

// --- notifications, token comparison, buffer cap (SR-006/SR-012/SR-014) ---

test("requests without an id are notifications and never get a response", async () => {
  const { server, port } = await startServer();
  try {
    const sock = await tlsRaw(port);
    let received = "";
    sock.on("data", (c) => { received += c; });
    // notification (no id, even with a bad token) → silence; then a real request → one reply.
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", method: "node/status", params: { token: "bad" } })}\n`);
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", method: "node/status", params: { token: TOKEN } })}\n`);
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node/status", params: { token: TOKEN } })}\n`);
    for (let i = 0; i < 50 && !received.includes("\n"); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50)); // grace period for any spurious replies
    const lines = received.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, 1);
    sock.destroy();
  } finally { await server.close(); }
});

test("a token of a different length is rejected, not a crash (timing-safe compare)", async () => {
  const { server, port } = await startServer();
  try {
    await assert.rejects(() => connectNode({ host: "127.0.0.1", port, token: "x" }));
  } finally { await server.close(); }
});

test("an oversized line without a newline gets the socket destroyed", async () => {
  const { server, port } = await startServer();
  try {
    const sock = await tlsRaw(port);
    const closed = new Promise((r) => sock.on("close", r));
    sock.write("x".repeat(1024 * 1024 + 64));
    await closed; // server must drop us, not buffer forever
  } finally { await server.close(); }
});

// --- config caching (SR-004) ---

test("loadFabricConfig caches by mtime and invalidates when the file changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-cfgcache-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  const stamp = (d) => utimesSync(cfgPath, d, d);
  try {
    writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "one" } }));
    const t0 = new Date(Date.now() - 10000);
    stamp(t0);
    assert.equal(loadFabricConfig(cfgPath).token, "one");
    // same mtime → cached content served, file not re-read.
    writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "two" } }));
    stamp(t0);
    assert.equal(loadFabricConfig(cfgPath).token, "one");
    // new mtime → cache invalidated.
    stamp(new Date());
    assert.equal(loadFabricConfig(cfgPath).token, "two");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A RELATIVE systemPromptFile resolves against the config file's directory (the synced
// repo root) — the shared config works across machines with different usernames instead
// of baking one box's absolute path into every box (linxu vs ezxmb14, WS1 repro 2026-08-11).
test("loadFabricConfig resolves a relative systemPromptFile to the config's real dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-sysprompt-"));
  const promptDir = join(dir, "system-prompt");
  try {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "claude-base.md"), "BASE");
    const cfgPath = join(dir, "claude_env_settings.json");
    writeFileSync(cfgPath, JSON.stringify({ fabric: { systemPromptFile: "system-prompt/claude-base.md" } }));
    utimesSync(cfgPath, new Date(), new Date()); // fresh mtime → cache sees a new file
    const fab = loadFabricConfig(cfgPath);
    assert.equal(fab.systemPromptFile, join(dir, "system-prompt", "claude-base.md"));
    assert.equal(existsSync(fab.systemPromptFile), true, "resolved path must exist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The `~`-prefixed convention is the primary one (setup links ~/.claude/system-prompt
// into the synced repo); an absolute path is kept for explicit overrides.
test("resolveSystemPromptFile expands ~ to home and keeps absolute paths", () => {
  const cfg = "C:/x/claude_env_settings.json";
  assert.equal(
    resolveSystemPromptFile("~/.claude/system-prompt/claude-base.md", cfg),
    join(homedir(), ".claude", "system-prompt", "claude-base.md"));
  assert.equal(resolveSystemPromptFile("C:/abs/prompt.md", cfg), "C:/abs/prompt.md");
  assert.equal(resolveSystemPromptFile(null, cfg), null);
});

// --- serve.mjs --port validation (SR-002) ---

test("serve.mjs exits 1 on a missing or non-numeric --port or --console-port value", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serveScript = join(here, "..", "scripts", "serve.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fabric-serveport-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "t" } }));
  const env = { ...process.env, CC_MARKET_CONFIG_PATH: cfgPath };
  try {
    for (const args of [["--port", "abc"], ["--port"], ["--console-port", "abc"], ["--console-port", "0"]]) {
      const r = spawnSync(process.execPath, [serveScript, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(r.status, 1, `args ${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /--(console-)?port/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── SR-045: the journal's owner.kind defaults to 'lib', which is right for a library
// caller and WRONG for every long-lived process that spawns sessions on someone's behalf.
// The mechanism is tested in session.test.mjs; what nothing else checks is that each
// process ENTRY POINT actually sets it. This is a SOURCE-level guard — it reads the
// scripts rather than observing a journal, because reaching recordEvent through serve
// needs a real provider child.

test("every session-spawning entry point declares its journal owner kind (source guard)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Comments must go FIRST: a guard that matches a commented-out call passes on exactly
  // the change it exists to catch (verified by commenting the call out, 2026-08-09).
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
  for (const script of ["serve.mjs", "mcp-server.mjs"]) {
    const src = stripComments(readFileSync(join(here, "..", "scripts", script), "utf8"));
    assert.match(src, /import \{[^}]*setJournalOwnerKind[^}]*\} from "\.\.\/engine\/session\.mjs"/,
      `${script} must import setJournalOwnerKind`);
    const call = src.match(/setJournalOwnerKind\(\s*["']([^"']+)["']\s*\)/);
    assert.ok(call, `${script} must call setJournalOwnerKind`);
    assert.notEqual(call[1], "lib", `${script} must not journal as the default library owner`);
  }
});

// ── serve is THE one entry point: it starts the LAN node AND the console in one process
// (scripts/up.* was the duplicated second spelling, deleted). --no-console opts out.

test("serve.mjs starts the node and the console together; --no-console starts only the node", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serveScript = join(here, "..", "scripts", "serve.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fabric-serveboth-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "serve-test-token" } }));

  // A free port, released before the child claims it.
  const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const listening = (port) => new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });

  async function run(extra) {
    const nodePort = await freePort();
    const consolePort = await freePort();
    const child = spawn(process.execPath,
      [serveScript, "--port", String(nodePort), "--console-port", String(consolePort), ...extra],
      { env: { ...process.env, CC_MARKET_CONFIG_PATH: cfgPath }, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    try {
      for (let i = 0; i < 300 && !/close this terminal/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(out, /close this terminal/, `serve never finished starting: ${out}`);
      return { out, node: await listening(nodePort), console: await listening(consolePort) };
    } finally {
      child.kill();
      await new Promise((r) => child.on("exit", r));
    }
  }

  try {
    const both = await run([]);
    assert.ok(both.node, "the LAN node must be listening");
    assert.ok(both.console, "the console must be listening — serve starts both");
    assert.match(both.out, /fabric console: http:\/\/127\.0\.0\.1:/);

    const nodeOnly = await run(["--no-console"]);
    assert.ok(nodeOnly.node, "the LAN node must still be listening");
    assert.equal(nodeOnly.console, false, "--no-console must leave the console port free");
    assert.doesNotMatch(nodeOnly.out, /fabric console/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── G3/G5: node/ping answers liveness facts remotely; a dropped connection rejects
// with a structured CONNECTION_LOST code, not a bare string.
test("node/ping returns session facts; remote handle exposes ping()", async () => {
  const deps = fakeSessionDeps();
  deps.pingSession = async (id) => ({ id, alive: true, pid: 555, turns: 0, lastActivity: 1 });
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const s = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "deepseek" });
    const facts = await s.ping();
    assert.equal(facts.pid, 555);
    assert.equal(facts.alive, true);
    await s.close();
  } finally { await server.close(); }
});

test("connection loss rejects pendings with code CONNECTION_LOST", async () => {
  const deps = fakeSessionDeps();
  deps.sendToSession = () => new Promise(() => {});
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", { provider: "deepseek" });
    const p = conn.request("node/send", { id: desc.id, prompt: "hang" });
    await server.close(); // drops the socket mid-request
    await assert.rejects(p, (e) => e.code === "CONNECTION_LOST" && /connection lost/.test(e.message));
  } finally { await server.close(); }
});

// ── G1: node/status must report capacity facts a scheduler can admit on —
// {name, sessions} alone left the layer above blind.
test("node/status reports version/uptime/cpu/memory capacity facts", async () => {
  const { server, port } = await startServer({ tags: ["femm"] });
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const st = await conn.request("node/status", {});
    assert.equal(st.name, "testnode");
    assert.ok(typeof st.version === "string" && st.version.length > 0, "version");
    assert.ok(typeof st.uptime_s === "number" && st.uptime_s >= 0, "uptime_s");
    assert.ok(Number.isInteger(st.cpu) && st.cpu > 0, "cpu count");
    assert.ok(typeof st.mem_available_mb === "number" && st.mem_available_mb > 0, "mem_available_mb");
    assert.ok(typeof st.mem_total_mb === "number" && st.mem_total_mb >= st.mem_available_mb, "mem_total_mb");
    assert.deepEqual(st.tags, ["femm"]);
    assert.ok(Array.isArray(st.sessions));
    conn.close();
  } finally { await server.close(); }
});

// CPU busy % needs a real sample window — a node whose server opted out (cpuSampleMs:0)
// reports null, one configured to sample reports a number in [0,100].
test("node/status reports cpu_busy_pct over a real sample window", async () => {
  const { server, port } = await startServer({ cpuSampleMs: 40 });
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const st = await conn.request("node/status", {});
    assert.equal(typeof st.cpu_busy_pct, "number", "cpu_busy_pct with a real window");
    assert.ok(st.cpu_busy_pct >= 0 && st.cpu_busy_pct <= 100);
    conn.close();
  } finally { await server.close(); }
});

// ── node/view: content tail + liveness facts. Read-only, like node/status/node/ping.
test("node/view returns a session's content and liveness facts; unknown id errors", async () => {
  const { server, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", { provider: "deepseek" });
    const v = await conn.request("node/view", { id: desc.id });
    assert.equal(v.id, desc.id);
    assert.equal(v.content, `transcript:${desc.id}`);
    assert.equal(v.alive, true);
    await assert.rejects(() => conn.request("node/view", { id: "nope" }), /No such session/);
    conn.close();
  } finally { await server.close(); }
});

test("node/view is read-only: a foreign connection (not the owner) can view but not act", async () => {
  const { server, port } = await startServer();
  try {
    const owner = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await owner.request("node/spawn", { provider: "deepseek" });
    const foreign = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const v = await foreign.request("node/view", { id: desc.id });
    assert.equal(v.id, desc.id, "viewing is visibility, not ownership");
    await assert.rejects(() => foreign.request("node/send", { id: desc.id, prompt: "hi" }), /not owned/);
    owner.close(); foreign.close();
  } finally { await server.close(); }
});

// ── sessionDefaults: node/spawn falls back to the node's default session when the
// caller omits provider/model/effort; overriding the provider leaves the default bundle
// (a deepseek model id must never ride a claude session).
test("node/spawn falls back to sessionDefaults; an explicit provider opts out of model/effort", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({
    token: TOKEN, name: "testnode", deps,
    sessionDefaults: { provider: "deepseek", model: "deepseek-v4-flash[1m]", effort: "max" },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", {});
    assert.equal(desc.provider, "deepseek");
    assert.equal(deps.opened[0].model, "deepseek-v4-flash[1m]");
    assert.equal(deps.opened[0].effort, "max");
    // Same default provider, explicit model → explicit wins.
    const desc2 = await conn.request("node/spawn", { provider: "deepseek", effort: "low" });
    assert.equal(desc2.provider, "deepseek");
    assert.equal(deps.opened[1].model, "deepseek-v4-flash[1m]");
    assert.equal(deps.opened[1].effort, "low");
    // Different provider → the default model/effort no longer apply.
    const desc3 = await conn.request("node/spawn", { provider: "codex" });
    assert.equal(desc3.provider, "codex");
    assert.equal(deps.opened[2].model, null, "a foreign provider must not inherit the default model");
    assert.equal(deps.opened[2].effort, null);
    conn.close();
  } finally { await server.close(); }
});

// SR-001: the peer must ENFORCE its own profiles — a client-supplied inline object is
// obedience, not enforcement. Names resolve against the SERVER's config; objects → -32602.
test("node/spawn rejects inline profile objects and resolves names server-side", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({
    token: TOKEN, name: "testnode", deps,
    profiles: { author: { allowedTools: "Read", permissionMode: "plan" } },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(
      conn.request("node/spawn", { provider: "deepseek", profile: { allowedTools: "Bash", permissionMode: "bypassPermissions" } }),
      (e) => e.code === -32602 && /name/i.test(e.message),
    );
    await conn.request("node/spawn", { provider: "deepseek", profile: "author" });
    assert.deepEqual(deps.opened.at(-1).profile, { allowedTools: "Read", permissionMode: "plan" });
    await assert.rejects(conn.request("node/spawn", { provider: "deepseek", profile: "nope" }), /author/);
    conn.close();
  } finally { await server.close(); }
});

// ── v2: SHARED sessions — any token-holder may drive them, and the spawner's
// disconnect must NOT reap them (lifecycle belongs to the journal instead).
test("a shared session is drivable by a second connection and survives the spawner's disconnect", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await c1.request("node/spawn", { provider: "deepseek", shared: true });
    const c2 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const r = await c2.request("node/send", { id: desc.id, prompt: "hi" });
    assert.equal(r.text, "echo:hi", "second connection must drive a shared session");
    c1.close();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(deps.listSessions().length, 1, "spawner disconnect must not reap a shared session");
    await c2.request("node/close", { id: desc.id });
    c2.close();
  } finally { await server.close(); }
});

test("node/compact acts on owned sessions, same ownership gate as send/close", async () => {
  const { server, port } = await startServer();
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await c1.request("node/spawn", { provider: "codex" });
    const r = await c1.request("node/compact", { id: desc.id });
    assert.deepEqual(r, { id: desc.id, provider: "codex", compacted: true, confirmed: true });

    // A foreign connection may not compact a non-shared session.
    const c2 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(c2.request("node/compact", { id: desc.id }), /not owned by this connection/);
    c2.close();
    await c1.request("node/close", { id: desc.id });
    c1.close();
  } finally { await server.close(); }
});

test("node/goal sets the condition; with prompt it runs the loop on the peer", async () => {
  const { server, port } = await startServer();
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await c1.request("node/spawn", { provider: "deepseek" });

    const set = await c1.request("node/goal", { id: desc.id, condition: "done when tests pass" });
    assert.equal(set.condition, "done when tests pass");
    assert.equal(set.active, true);

    const run = await c1.request("node/goal", { id: desc.id, prompt: "go", maxTurns: 5 });
    assert.equal(run.state, "met");
    assert.equal(run.text, "goal:go");

    // Ownership gate: a foreign connection may not set/run goals on a private session.
    const c2 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(c2.request("node/goal", { id: desc.id, condition: "x" }), /not owned by this connection/);
    c2.close();
    await c1.request("node/close", { id: desc.id });
    c1.close();
  } finally { await server.close(); }
});

test("node/goal on a SHARED session works from a second connection (the attach convention)", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await c1.request("node/spawn", { provider: "deepseek", shared: true });
    const c2 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const r = await c2.request("node/goal", { id: desc.id, condition: "any token-holder may set it" });
    assert.equal(r.active, true);
    await c2.request("node/close", { id: desc.id });
    c1.close(); c2.close();
  } finally { await server.close(); }
});

test("node/compact on a SHARED session works from a second connection (the attach convention)", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await c1.request("node/spawn", { provider: "codex", shared: true });
    const c2 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const r = await c2.request("node/compact", { id: desc.id });
    assert.equal(r.confirmed, true, "any token-holder may compact a shared session");
    await c2.request("node/close", { id: desc.id });
    c1.close(); c2.close();
  } finally { await server.close(); }
});

test("node/compact on an unknown id is rejected by the ownership gate (foreign id), same as send/close", async () => {
  const { server, port } = await startServer();
  try {
    const c1 = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(c1.request("node/compact", { id: "sess-ghost" }), /not owned by this connection/);
    c1.close();
  } finally { await server.close(); }
});

test("node/status carries the project list and maps session cwd to a project alias", async () => {
  const deps = fakeSessionDeps();
  deps.listSessions = () => [{ id: "s1", provider: "deepseek", turns: 0, cwd: "/data/thesis/sub" }];
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps, projects: { thesis: "/data/thesis" } });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const st = await conn.request("node/status", {});
    assert.deepEqual(st.projects, ["thesis"]);
    assert.equal(st.sessions[0].project, "thesis", "cwd under the alias root maps to the alias");
    conn.close();
  } finally { await server.close(); }
});

// ── SR-004/023/043: a peer that ACCEPTS and then goes silent is a different failure from
// a peer that drops. Without a per-request deadline the caller waits forever.

test("a request to an accept-then-silent peer rejects with REQUEST_TIMEOUT, not CONNECTION_LOST", async () => {
  const deps = fakeSessionDeps();
  deps.sendToSession = () => new Promise(() => {}); // accepted, never answered
  const server = createNodeServer({ token: TOKEN, name: "silent", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", { provider: "x" });
    const started = Date.now();
    await assert.rejects(
      () => conn.request("node/send", { id: desc.id, prompt: "hi" }, { timeoutMs: 200 }),
      (e) => e.code === "REQUEST_TIMEOUT" && /timed out/i.test(e.message),
    );
    assert.ok(Date.now() - started < 3000, "must reject at its own deadline, not hang");
    // The connection stays usable, and the timed-out pending is gone.
    assert.equal((await conn.request("node/status", {})).name, "silent");
    conn.close();
  } finally { await server.close(); }
});

test("a late reply to a timed-out request is dropped, not delivered", async () => {
  const deps = fakeSessionDeps();
  let release;
  deps.sendToSession = () => new Promise((r) => { release = () => r({ text: "late", turn: 9 }); });
  const server = createNodeServer({ token: TOKEN, name: "late", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", { provider: "x" });
    await assert.rejects(() => conn.request("node/send", { id: desc.id, prompt: "hi" }, { timeoutMs: 100 }),
      (e) => e.code === "REQUEST_TIMEOUT");
    release();
    await new Promise((r) => setTimeout(r, 100));
    const st = await conn.request("node/status", {});
    assert.equal(st.name, "late", "the late reply must not have been mistaken for this one");
    conn.close();
  } finally { await server.close(); }
});

test("node/spawn gets a longer default deadline than an ordinary request", async () => {
  const { DEFAULT_REQUEST_TIMEOUT_MS, SPAWN_REQUEST_TIMEOUT_MS } = await import("../engine/node-client.mjs");
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 120000);
  assert.ok(SPAWN_REQUEST_TIMEOUT_MS > DEFAULT_REQUEST_TIMEOUT_MS, "a spawn may legitimately take longer");
});

// ── SR-030: the client read buffer was unbounded while the server capped its own.

test("a peer that floods without a newline is dropped, and says so as RESPONSE_TOO_LARGE", async () => {
  // A raw TLS-PSK peer that floods without ever sending a newline.
  let peerSock = null;
  const raw = await new Promise((resolve) => {
    const s = tls.createServer({
      pskCallback: () => pskFromToken(TOKEN),
      ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
    }, (c) => { peerSock = c; c.on("error", () => {}); c.write("x".repeat(MAX_LINE_BYTES + 4096)); });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const conn = await connectNode({ host: "127.0.0.1", port: raw.address().port, token: TOKEN });
    for (let i = 0; i < 300 && !conn.destroyed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(conn.destroyed, "the client must drop a peer that floods it past the cap");
    // The CAUSE survives the socket: a later request names the flood, not a bare loss.
    await assert.rejects(() => conn.request("node/status", {}, { timeoutMs: 2000 }),
      (e) => e.code === "RESPONSE_TOO_LARGE");
  } finally { peerSock?.destroy(); raw.close(); }
});

// ── SR-027/048: one TCP connection per remote session is linear fd cost with no
// heartbeat. Sessions to the SAME peer must share one pooled, multiplexed connection.

test("two sessions on one peer share a single pooled connection, released at refcount 0", async () => {
  const { server, port } = await startServer();
  const here = () => poolStats().filter((p) => p.port === port);
  try {
    const a = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "a" });
    const b = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "b" });
    assert.equal(here().length, 1, "one pooled connection for the peer");
    assert.equal(here()[0].refs, 2, "both sessions hold a reference");
    assert.equal((await a.send("one")).text, "echo:one");
    assert.equal((await b.send("two")).text, "echo:two");
    await a.close();
    assert.equal(here()[0]?.refs, 1, "closing one session must not drop the shared socket");
    assert.equal((await b.send("still here")).text, "echo:still here");
    await b.close();
    assert.equal(here().length, 0, "the connection closes when the last session releases it");
  } finally { await server.close(); }
});

test("attachRemoteSession shares the same pooled connection as a spawned session", async () => {
  const { server, port } = await startServer();
  try {
    const a = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "a", shared: true });
    const b = await attachRemoteSession({ host: "127.0.0.1", port, token: TOKEN, id: a.id });
    const here = poolStats().filter((p) => p.port === port);
    assert.equal(here.length, 1);
    assert.equal(here[0].refs, 2);
    assert.equal((await b.send("hi")).text, "echo:hi");
    await b.close(); // closes the REMOTE session and releases one reference
    // a's own close() now finds the session gone — it must still release its reference,
    // or a failed close would leak the pooled socket forever.
    await assert.rejects(() => a.close(), (e) => e.code === -32602);
    assert.equal(poolStats().filter((p) => p.port === port).length, 0, "a failed close still releases");
  } finally { await server.close(); }
});

test("a pooled connection never leaks the token in poolStats", async () => {
  const { server, port } = await startServer();
  try {
    const a = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "a" });
    assert.ok(!JSON.stringify(poolStats()).includes(TOKEN), "observability must not print the credential");
    await a.close();
  } finally { await server.close(); }
});

test("the pool heartbeat reaps a peer that stops answering", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: TOKEN, name: "heart", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  _setPoolHeartbeatMs(50);
  try {
    const h = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "a" });
    assert.equal(poolStats().filter((p) => p.port === port).length, 1);
    await server.close(); // peer gone; the heartbeat must notice without a send
    for (let i = 0; i < 100 && poolStats().some((p) => p.port === port); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(poolStats().filter((p) => p.port === port).length, 0, "a dead pooled connection is evicted");
    await assert.rejects(() => h.send("anyone there"), (e) => e.code === "CONNECTION_LOST");
  } finally { _setPoolHeartbeatMs(null); await server.close(); }
});

// ── SR-013/029/046: node/status served the whole registry, usage objects included, on
// every 6-second console poll. `detail` lets a caller ask for what it renders.

test("node/status defaults to a light summary and returns usage only for detail full", async () => {
  const deps = fakeSessionDeps();
  deps.listSessions = () => [{
    id: "s1", provider: "claude", turns: 3, alive: true, lastActivity: 42,
    usage: { cost_usd: 1.25, input_tokens: 99 }, cwd: "/data/thesis/sub", pid: 7,
  }];
  const server = createNodeServer({ token: TOKEN, name: "n", deps, projects: { thesis: "/data/thesis" } });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const light = await conn.request("node/status", {});
    assert.equal(light.sessions_count, 1);
    const ls = light.sessions[0];
    assert.deepEqual(Object.keys(ls).sort(), ["alive", "id", "lastActivity", "project", "provider", "shared"].sort());
    assert.equal(ls.project, "thesis");
    assert.equal(ls.usage, undefined, "light must not carry usage objects");

    const full = await conn.request("node/status", { detail: "full" });
    assert.equal(full.sessions[0].usage.cost_usd, 1.25);
    assert.equal(full.sessions[0].turns, 3);
    await assert.rejects(() => conn.request("node/status", { detail: "medium" }), (e) => e.code === -32602);
    conn.close();
  } finally { await server.close(); }
});

// ── SR-036: an unbounded reply is the mirror of an unbounded request line.

test("a reply larger than the cap is replaced by a structured RESULT_TOO_LARGE error", async () => {
  const deps = fakeSessionDeps();
  deps.sendToSession = async () => ({ text: "y".repeat(9 * 1024 * 1024), turn: 1 });
  const server = createNodeServer({ token: TOKEN, name: "big", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const desc = await conn.request("node/spawn", { provider: "x" });
    await assert.rejects(
      () => conn.request("node/send", { id: desc.id, prompt: "p" }, { timeoutMs: 15000 }),
      (e) => e.code === "RESULT_TOO_LARGE" && /\d{6,}/.test(e.message),
    );
    assert.equal((await conn.request("node/status", {})).name, "big", "the connection survives");
    conn.close();
  } finally { await server.close(); }
});

// ── SR-025/041: a static operator-declared ceiling. Dynamic admission stays in swarm;
// this only refuses past an invariant the operator wrote down.

test("node/spawn refuses past serve.maxSessions with CAPACITY_CEILING, and status reports the ceiling", async () => {
  const { server, port } = await startServer({ maxSessions: 1 });
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const st0 = await conn.request("node/status", {});
    assert.equal(st0.maxSessions, 1);
    assert.equal(st0.sessions_count, 0);
    await conn.request("node/spawn", { provider: "a" });
    await assert.rejects(() => conn.request("node/spawn", { provider: "b" }), (e) =>
      e.code === "CAPACITY_CEILING" && e.data.maxSessions === 1 && e.data.sessions === 1);
    assert.equal((await conn.request("node/status", {})).sessions_count, 1);
    conn.close();
  } finally { await server.close(); }
});

test("maxSessions defaults to 64 when the operator declares nothing", async () => {
  const { server, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    assert.equal((await conn.request("node/status", {})).maxSessions, 64);
    conn.close();
  } finally { await server.close(); }
});

// The ceiling check reads the registry BEFORE _createSession registers, so two
// concurrent spawns both saw a free slot and both spawned — a team_spawn fan-out
// overshot the declared ceiling. In-flight admissions must count toward the check.
test("node/view fills project from cwd exactly as node/status does (attach learns it)", async () => {
  const deps = fakeSessionDeps();
  // Registry project is null but cwd sits inside an alias root: node/status groups
  // this session under the alias, so the view MUST agree — attachSession learns the
  // project from the view, and a mismatch shows "no project recorded" for a session
  // the status list places under its project.
  // deps are captured at createNodeServer construction, so one override answers per id
  // (reassigning deps.viewSession between requests would NOT take effect).
  deps.viewSession = async (id) => ({ id, provider: "claude", content: "", alive: true, project: null,
    cwd: id === "sess-a" ? "D:\\code\\myapp\\sub" : "C:/elsewhere" });
  const server = createNodeServer({ token: TOKEN, name: "testnode", cpuSampleMs: 0, deps,
    projects: { myapp: "D:/code/myapp" } });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const v = await conn.request("node/view", { id: "sess-a", tailChars: 0 });
    assert.equal(v.project, "myapp", "cwd inside the alias root reverse-maps (backslash-normalized)");
    const v2 = await conn.request("node/view", { id: "sess-b", tailChars: 0 });
    assert.equal(v2.project ?? null, null, "cwd outside every alias honestly stays null");
    conn.close();
  } finally { await server.close(); }
});

test("node/spawn admission is atomic: concurrent spawns cannot overshoot the ceiling", async () => {
  const deps = fakeSessionDeps();
  const origCreate = deps.createSession;
  let release;
  const blocked = new Promise((r) => { release = r; });
  let calls = 0;
  deps.createSession = async (opts) => {
    calls++;
    await blocked; // hold the first spawn mid-flight so the second races the ceiling check
    return origCreate(opts);
  };
  const server = createNodeServer({ token: TOKEN, name: "testnode", cpuSampleMs: 0, deps, maxSessions: 1 });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    // Wrap at creation: the loser's rejection lands within milliseconds, and an
    // allSettled attached only after release() would leave it unhandled in between.
    const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));
    const p1 = settle(conn.request("node/spawn", { provider: "a" }));
    const p2 = settle(conn.request("node/spawn", { provider: "b" }));
    for (let i = 0; i < 100 && calls < 1; i++) await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await Promise.all([p1, p2]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ceiling = results.filter((r) => r.status === "rejected" && r.reason.code === "CAPACITY_CEILING");
    assert.equal(ok.length, 1, "exactly one spawn may succeed");
    assert.equal(ceiling.length, 1, "the loser must hit CAPACITY_CEILING, not squeeze past it");
    conn.close();
  } finally { await server.close(); }
});

// ── SR-011: a close that reports no cost leaves the journal with no cost facts to record.

test("node/close returns the session usage and the handle exposes it after close", async () => {
  const deps = fakeSessionDeps();
  deps.closeSession = async (id) => ({ id, exitCode: 0, turns: 4, usage: { cost_usd: 0.5 } });
  const server = createNodeServer({ token: TOKEN, name: "n", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const h = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "x" });
    const code = await h.close();
    assert.equal(code, 0, "close() still returns the exit code scalar the registry reads");
    assert.deepEqual(h.usage, { cost_usd: 0.5 }, "the registry journals handle.usage");
    assert.equal(h.turns, 4);
  } finally { await server.close(); }
});

test("a remote handle records liveness facts observed via ping()", async () => {
  const deps = fakeSessionDeps();
  deps.pingSession = async (id) => ({ id, alive: false, pid: 3, turns: 2, lastActivity: 7, usage: { cost_usd: 0.25 } });
  const server = createNodeServer({ token: TOKEN, name: "n", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const h = await openRemoteSession({ host: "127.0.0.1", port, token: TOKEN, provider: "x" });
    await h.ping();
    assert.equal(h.alive, false, "an observed-dead remote is visible to listSessions()");
    assert.deepEqual(h.usage, { cost_usd: 0.25 });
    await h.close();
  } finally { await server.close(); }
});

// ── SR-033/051: one fleet-wide PSK cannot be revoked without re-syncing every machine.
// A SET of accepted tokens makes revocation a one-line edit on the node.

test("a server accepts any token in its set, and rejects one that was never issued", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: "primary-token", tokens: ["peer-b-token"], name: "n", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    for (const t of ["primary-token", "peer-b-token"]) {
      const conn = await connectNode({ host: "127.0.0.1", port, token: t });
      assert.equal((await conn.request("node/status", {})).name, "n", `token ${t} must be accepted`);
      conn.close();
    }
    await assert.rejects(() => connectNode({ host: "127.0.0.1", port, token: "revoked-token" }));
  } finally { await server.close(); }
});

test("the PSK identity fingerprints the token, and the legacy bare identity maps to the primary", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: "primary-token", tokens: ["peer-b-token"], name: "n", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    assert.match(identityForToken("peer-b-token"), /^fabric-node:[0-9a-f]{12}$/);
    assert.notEqual(identityForToken("peer-b-token"), identityForToken("primary-token"));
    // A peer running an older fabric sends the bare identity: it maps to the primary token.
    const legacy = await new Promise((resolve, reject) => {
      const s = tls.connect({
        host: "127.0.0.1", port,
        pskCallback: () => ({ psk: pskFromToken("primary-token"), identity: PSK_IDENTITY }),
        ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
        checkServerIdentity: () => undefined,
      });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
    legacy.destroy();
  } finally { await server.close(); }
});

test("a per-request token from outside the accepted set is refused after a good handshake", async () => {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: "primary-token", tokens: ["peer-b-token"], name: "n", deps });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const sock = await new Promise((resolve, reject) => {
      const s = tls.connect({
        host: "127.0.0.1", port,
        pskCallback: () => ({ psk: pskFromToken("peer-b-token"), identity: identityForToken("peer-b-token") }),
        ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
        checkServerIdentity: () => undefined,
      });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
    let received = "";
    sock.on("data", (c) => { received += c; });
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node/status", params: { token: "primary-token" } })}\n`);
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "node/status", params: { token: "never-issued" } })}\n`);
    for (let i = 0; i < 100 && received.split("\n").filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    // Match replies by JSON-RPC id — dispatch is non-awaiting, so two concurrent
    // requests may be answered in either order (a status now carries a ~120ms CPU sample).
    const byId = Object.fromEntries(received.split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.id, o]; }));
    assert.equal(byId[1].result.name, "n", "any accepted token authorizes a request");
    assert.equal(byId[2].error.code, AUTH_ERROR);
    sock.destroy();
  } finally { await server.close(); }
});

// ── SR-053: mtimeMs has 1-second granularity on Windows, so a same-second edit was
// invisible to a long-lived daemon forever.

test("loadFabricConfig expires its cache after a TTL even when mtime is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-cfgttl-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  const t0 = new Date(Date.now() - 10000);
  try {
    writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "one" } }));
    utimesSync(cfgPath, t0, t0);
    assert.equal(loadFabricConfig(cfgPath).token, "one");
    writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "two" } }));
    utimesSync(cfgPath, t0, t0); // same mtime: only a TTL can save the reader
    assert.equal(loadFabricConfig(cfgPath).token, "one", "still fresh within the TTL");
    assert.equal(loadFabricConfig(cfgPath, { ttlMs: 0 }).token, "two", "an expired entry is re-read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── SR-014: "serving: no" for a TLS/auth failure is a lie in exactly the case you would
// run the diagnostic for.

test("serve --status says no only for a refused connection, unknown for anything else", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serveScript = join(here, "..", "scripts", "serve.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fabric-servestatus-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "t" } }));
  const run = (port) => spawnSync(process.execPath, [serveScript, "--status", "--port", String(port)],
    { env: { ...process.env, CC_MARKET_CONFIG_PATH: cfgPath }, encoding: "utf8", windowsHide: true, timeout: 30000 });
  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  try {
    assert.match(run(free).stdout, /serving: no \(/);
    // A port held by something that is not a fabric node: NOT "no" — we cannot tell.
    const squatter = net.createServer((c) => c.on("error", () => {}));
    await new Promise((r) => squatter.listen(free, "127.0.0.1", r));
    try {
      assert.match(run(free).stdout, /serving: unknown \(/);
    } finally { await new Promise((r) => squatter.close(r)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── serve shutdown must not orphan session children ──────────────────────────
// A session child is windowsHide by design: when serve dies, nothing visible
// remains to remind the operator it exists. close() therefore reaps EVERY
// session this process spawned — graceful close first, hard pid-kill for one
// that hangs past its grace.

test("server.close() closes every live session before shutting down", async () => {
  const { server, deps, port } = await startServer();
  const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
  await conn.request("node/spawn", { provider: "deepseek" });
  await conn.request("node/spawn", { provider: "deepseek", shared: true });
  assert.equal(deps.listSessions().length, 2);
  conn.close();
  await server.close();
  assert.equal(deps.listSessions().length, 0, "close() must reap owned AND shared sessions");
});

test("server.close() hard-kills a session whose graceful close hangs", async () => {
  const killed = [];
  const deps = fakeSessionDeps();
  deps.closeSession = () => new Promise(() => {}); // never settles
  deps.listSessions = () => [{ id: "sess-hung", provider: "deepseek", turns: 0, pid: 4242, alive: true }];
  const server = createNodeServer({ token: TOKEN, name: "t", deps, _kill: (pid) => killed.push(pid), _closeGraceMs: 50 });
  await server.listen(0, "127.0.0.1");
  await server.close();
  assert.deepEqual(killed, [4242], "a hung close must fall back to killing the child pid");
});
