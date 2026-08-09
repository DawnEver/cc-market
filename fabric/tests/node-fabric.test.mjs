// tests/node-fabric.test.mjs — LAN node fabric: server auth, spawn/send/close roundtrip,
// project alias resolution, remote session handle, connection-loss rejection, config loading.
// All over real localhost sockets with injected fake provider sessions — no real providers.

// Isolate the session journal: registry events must never pollute the user's real ~/.fabric.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-test-'));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import tls from "node:tls";
import { PSK_IDENTITY, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken } from "../engine/node-tls.mjs";

import { createNodeServer, AUTH_ERROR } from "../engine/node-server.mjs";
import { connectNode, openRemoteSession } from "../engine/node-client.mjs";
import { loadFabricConfig, resolveNode, loadServeConfig } from "../engine/node-config.mjs";
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
    listSessions: () => [...sessions.entries()].map(([id, s]) => ({ id, provider: s.provider, turns: s.turns })),
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
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps, ...extra });
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

// --- serve.mjs --port validation (SR-002) ---

test("serve.mjs exits 1 on a missing or non-numeric --port value", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serveScript = join(here, "..", "scripts", "serve.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fabric-serveport-"));
  const cfgPath = join(dir, "claude_env_settings.json");
  writeFileSync(cfgPath, JSON.stringify({ fabric: { token: "t" } }));
  const env = { ...process.env, CC_MARKET_CONFIG_PATH: cfgPath };
  try {
    for (const args of [["--port", "abc"], ["--port"]]) {
      const r = spawnSync(process.execPath, [serveScript, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(r.status, 1, `args ${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /--port/);
    }
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
