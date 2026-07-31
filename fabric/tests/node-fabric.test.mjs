// tests/node-fabric.test.mjs — LAN node fabric: server auth, spawn/send/close roundtrip,
// project alias resolution, remote session handle, connection-loss rejection, config loading.
// All over real localhost sockets with injected fake provider sessions — no real providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";

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

async function startServer(extra = {}) {
  const deps = fakeSessionDeps();
  const server = createNodeServer({ token: TOKEN, name: "testnode", deps, ...extra });
  const { port } = await server.listen(0, "127.0.0.1");
  return { server, deps, port };
}

test("createNodeServer refuses to start without a token", () => {
  assert.throws(() => createNodeServer({}), /token/);
});

test("rejects requests with a bad token", async () => {
  const { server, port } = await startServer();
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: "wrong" });
    await assert.rejects(() => conn.request("node/status", {}), (e) => e.code === AUTH_ERROR);
    conn.close();
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
  // A raw server that accepts, reads, and never replies — then dies.
  const raw = net.createServer((sock) => setTimeout(() => sock.destroy(), 50));
  const port = await new Promise((res) => raw.listen(0, "127.0.0.1", () => res(raw.address().port)));
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(() => conn.request("node/status", {}), /connection/i);
  } finally { raw.close(); }
});

test("malformed JSON on the wire does not kill the server", async () => {
  const { server, port } = await startServer();
  try {
    const sock = net.connect({ host: "127.0.0.1", port });
    await new Promise((r) => sock.on("connect", r));
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
          "DUIP622037": { port: 8000, projects: { thesis: "D:/repos/thesis" } },
          "mac.local": { name: "mac" },
        },
      },
    },
  }));
  try {
    // FQDN hostname matches the short byHost key, case-insensitively.
    const s = loadServeConfig(cfgPath, "duip622037.ad.nottingham.ac.uk");
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
