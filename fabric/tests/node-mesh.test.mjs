// tests/node-mesh.test.mjs — P1/P2/P3: Ed25519 node identity (hello/prove handshake,
// pins, TOFU), symmetric edges (requests in both directions on one socket), the mesh
// keeper (dedupe by the smaller-dialer rule, inbound adoption = connection reversal),
// and node/forward relaying including the console-side fallback in openRemoteSession.
// Real localhost sockets, fake provider sessions — same conventions as node-fabric.test.mjs.

process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-mesh-test-'));
import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import net from "node:net";

import { createNodeServer } from "../engine/node-server.mjs";
import { connectNode, openRemoteSession, localIdentity } from "../engine/node-client.mjs";
import { createMesh } from "../engine/node-mesh.mjs";
import { loadOrCreateIdentity, fingerprintOfPublicKey, trustPeer, signChallenge, readKnownPeers, FINGERPRINT_PREFIX } from "../engine/node-identity.mjs";
import { PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken } from "../engine/node-tls.mjs";

const TOKEN = "mesh-test-secret";

function fakeDeps() {
  const sessions = new Map();
  let seq = 0;
  return {
    createSession: async (opts) => {
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
    closeSession: async (id) => { sessions.delete(id); return { id, exitCode: 0 }; },
    listSessions: () => [...sessions.entries()].map(([id, s]) => ({ id, provider: s.provider, turns: s.turns })),
    pingSession: async (id) => ({ id, alive: true }),
    viewSession: async (id) => ({ id, content: `transcript:${id}`, alive: true }),
  };
}

async function startNode(name, extra = {}) {
  const server = createNodeServer({ token: TOKEN, name, cpuSampleMs: 0, deps: fakeDeps(), ...extra });
  const { port } = await server.listen(0, "127.0.0.1");
  return { server, port };
}

// ── P3: identity storage and proofs ──

test("identity is generated once, persists, and its fingerprint matches the key", async () => {
  const a = loadOrCreateIdentity();
  const b = loadOrCreateIdentity();
  assert.equal(a.fingerprint, b.fingerprint, "same machine, same identity across loads");
  assert.match(a.fingerprint, new RegExp(`^${FINGERPRINT_PREFIX}[0-9a-f]{24}$`));
  assert.equal(a.fingerprint, fingerprintOfPublicKey(a.publicKey));
  const sig = signChallenge(a.privateKey, "payload");
  assert.ok(sig.length > 0);
});

test("trustPeer: pin wins; TOFU records, accepts the known, and refuses a CHANGED key", async () => {
  const fp = loadOrCreateIdentity().fingerprint;
  const other = "ed25519:" + "f".repeat(24);
  assert.deepEqual(trustPeer("pinned-node", fp, fp), { ok: true, via: "pinned" });
  assert.equal(trustPeer("pinned-node", other, fp).ok, false, "a pin mismatch refuses");
  assert.equal(trustPeer("tofu-node", fp, null).via, "tofu-new");
  assert.equal(trustPeer("tofu-node", fp, null).via, "tofu-known");
  const changed = trustPeer("tofu-node", other, null);
  assert.equal(changed.ok, false, "a changed fingerprint is never silently accepted");
  assert.match(changed.reason, /CHANGED/);
  assert.equal(readKnownPeers()["tofu-node"].fingerprint, fp, "the cache keeps the FIRST fact");
});

// ── P2: symmetric edges — the dial direction stops mattering ──

test("a connection carries requests in BOTH directions once the server also asks", async () => {
  // The server side keeps a handle to each edge and can request over it.
  let serverSideEdge = null;
  const { server, port } = await startNode("srv", { onEdge: (e) => { serverSideEdge = e; } });
  try {
    const conn = await connectNode({
      host: "127.0.0.1", port, token: TOKEN,
      onRequest: async (method) => {
        if (method === "peer/whoareyou") return { iAm: "the-client" };
        throw Object.assign(new Error("nope"), { code: -32601 });
      },
    });
    await conn.request("node/status", {}); // ordinary direction still works
    const r = await serverSideEdge.request("peer/whoareyou", {});
    assert.equal(r.iAm, "the-client", "the dialer answers requests too — one socket, both directions");
    conn.close();
  } finally { await server.close(); }
});

test("hello/prove verifies both ends; a wrong key or a pin mismatch fails the edge", async () => {
  const idA = loadOrCreateIdentity();
  const { server, port } = await startNode("srv");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN, identity: { ...idA, name: "cli" } });
    const mine = await conn.peerReady;
    assert.equal(mine.verified, true, "the server proved its identity to the client");
    assert.equal(mine.peer.name, "srv");
    assert.match(mine.peer.fingerprint, /^ed25519:[0-9a-f]{24}$/);
    conn.close();
  } finally { await server.close(); }
});

test("an impostor presenting another node's identity fails the proof", async () => {
  const victim = loadOrCreateIdentity();
  const forger = (await import("node:crypto")).generateKeyPairSync("ed25519");
  const fakeIdentity = {
    name: "impostor",
    fingerprint: victim.fingerprint, // claims the victim's fingerprint…
    publicKey: victim.publicKey,
    privateKey: forger.privateKey.export({ type: "pkcs8", format: "pem" }), // …but signs with its own key
  };
  const { server, port } = await startNode("srv");
  try {
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN, identity: fakeIdentity });
    // The SERVER rejects us once our prove doesn't verify against the claimed key.
    let closed = false;
    conn.onClose(() => { closed = true; });
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(closed, "the server must drop an edge whose proof does not match the claimed identity");
  } finally { await server.close(); }
});

test("a pinned fingerprint fails a legacy (pre-mesh) peer closed", async () => {
  // A legacy server: plain TLS-PSK, never says hello.
  const legacy = tls.createServer({
    pskCallback: () => pskFromToken(TOKEN),
    ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
  }, (s) => s.on("error", () => {}));
  await new Promise((r) => legacy.listen(0, "127.0.0.1", r));
  try {
    const pin = loadOrCreateIdentity().fingerprint;
    await assert.rejects(
      connectNode({ host: "127.0.0.1", port: legacy.address().port, token: TOKEN, pinnedFingerprint: pin, helloTimeoutMs: 300 }),
      (e) => e.code === "IDENTITY_REQUIRED" || e.code === "CONNECTION_LOST",
    );
  } finally { legacy.close(); }
});

test("an UNPINNED legacy peer still works (backward compatibility), marked legacy", async () => {
  const legacy = tls.createServer({
    pskCallback: () => pskFromToken(TOKEN),
    ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
  }, (s) => {
    s.on("data", (c) => {
      const line = String(c).split("\n").find((l) => l.includes('"method"'));
      if (line) {
        const req = JSON.parse(line);
        if (req.id !== undefined) s.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { old: true } })}\n`);
      }
    });
    s.on("error", () => {});
  });
  await new Promise((r) => legacy.listen(0, "127.0.0.1", r));
  try {
    const conn = await connectNode({ host: "127.0.0.1", port: legacy.address().port, token: TOKEN, helloTimeoutMs: 300 });
    assert.deepEqual(await conn.request("node/status", {}), { old: true }, "requests to a legacy peer just work");
    const r = await conn.peerReady;
    assert.equal(r.legacy, true);
    conn.close();
  } finally { legacy.close(); }
});

// ── P1/P2: the mesh keeper — reversal, dedupe, forward ──

// Reversal, with adoption wired BEFORE any edge exists.
test("reversal end-to-end: forward rides an inbound edge the target dialed itself", async () => {
  const mk = async (name) => {
    let mesh = null;
    const server = createNodeServer({
      token: TOKEN, name, cpuSampleMs: 0, deps: fakeDeps(),
      getMesh: () => mesh,
      onEdge: (e) => mesh?.adoptInbound(e),
    });
    const { port } = await server.listen(0, "127.0.0.1");
    return { server, port, setMesh: (m) => { mesh = m; } };
  };
  const ws1 = await mk("ws1");
  const g = await mk("g");
  try {
    // ws1 cannot dial g — its connect always times out.
    const meshWs1 = createMesh({
      name: "ws1",
      nodes: () => ({ g: { host: "127.0.0.1", port: g.port, token: TOKEN } }),
      connect: () => Promise.reject(Object.assign(new Error("connectNode: timed out"), { code: "CONNECT_TIMEOUT" })),
    });
    ws1.setMesh(meshWs1);
    // g CAN dial ws1 — and answers requests coming back over its outbound edge.
    const meshG = createMesh({
      name: "g",
      nodes: () => ({ ws1: { host: "127.0.0.1", port: ws1.port, token: TOKEN } }),
      onRequest: (m, p) => g.server.serveRequest(m, p),
    });
    g.setMesh(meshG);

    await meshG.ensureEdge("ws1"); // g dials out…
    // …and ws1 sees the inbound edge named "g"? NO — g's edge is TO ws1; ws1's mesh
    // sees an inbound edge FROM g. Wait: g dialed ws1, so ws1 holds an edge whose PEER
    // is g. That is exactly the reversal: ws1's route to g arrived by itself.
    for (let i = 0; i < 100 && !meshWs1.edgeList().some((e) => e.peer === "g"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const edgeRow = meshWs1.edgeList().find((e) => e.peer === "g");
    assert.ok(edgeRow, "ws1 must hold an edge named g (dialed BY g)");
    assert.equal(edgeRow.direction, "in");
    assert.equal(edgeRow.verified, true);

    // Now ws1 forwards a request to g over that inbound edge — spawn + echo roundtrip.
    const desc = await meshWs1.forward("g", "node/spawn", { provider: "deepseek" });
    assert.ok(desc.id);
    const ack = await meshWs1.forward("g", "node/send", { id: desc.id, prompt: "over the reversed edge" });
    assert.equal(ack.accepted, true, "node/send acks on delivery over the mesh");
    const r = await meshWs1.forward("g", "node/turn", { id: desc.id, seq: ack.seq });
    assert.equal(r.text, "echo:over the reversed edge");
    await meshWs1.forward("g", "node/close", { id: desc.id });

    meshWs1.stop(); meshG.stop();
  } finally { await ws1.server.close(); await g.server.close(); }
});

test("dedupe: when both nodes dial, exactly one edge survives — the smaller name's outbound", async () => {
  const mk = async (name) => {
    let mesh = null;
    const server = createNodeServer({
      token: TOKEN, name, cpuSampleMs: 0, deps: fakeDeps(),
      getMesh: () => mesh, onEdge: (e) => mesh?.adoptInbound(e),
    });
    const { port } = await server.listen(0, "127.0.0.1");
    return { server, port, setMesh: (m) => { mesh = m; } };
  };
  // Names chosen so a < b: a's OUTBOUND edge must win on BOTH boxes.
  const a = await mk("a");
  const b = await mk("b");
  try {
    const meshA = createMesh({ name: "a", nodes: () => ({ b: { host: "127.0.0.1", port: b.port, token: TOKEN } }) });
    const meshB = createMesh({ name: "b", nodes: () => ({ a: { host: "127.0.0.1", port: a.port, token: TOKEN } }) });
    a.setMesh(meshA); b.setMesh(meshB);
    await Promise.all([meshA.ensureEdge("b"), meshB.ensureEdge("a")]);
    // Both directions were attempted; each box must converge to ONE edge, and the
    // surviving edge is a's outbound (a < b).
    for (let i = 0; i < 100; i++) {
      const ea = meshA.edgeList().filter((e) => e.peer === "b");
      const eb = meshB.edgeList().filter((e) => e.peer === "a");
      if (ea.length === 1 && eb.length === 1) {
        assert.equal(ea[0].direction, "out", "a's own dial survives on a");
        assert.equal(eb[0].direction, "in", "the same edge reads inbound on b");
        meshA.stop(); meshB.stop();
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`dedupe did not converge: a=${JSON.stringify(meshA.edgeList())} b=${JSON.stringify(meshB.edgeList())}`);
  } finally { await a.server.close(); await b.server.close(); }
});

test("node/forward relays through the local daemon: console fallback spawns on an unreachable node", async () => {
  // The console's view: direct dial to G fails (nothing listens), but the LOCAL daemon
  // holds a mesh edge to G. openRemoteSession with a route must relay transparently.
  const g = await startNode("g");
  let localMesh = null;
  const localServer = createNodeServer({
    token: TOKEN, name: "localbox", cpuSampleMs: 0, deps: fakeDeps(),
    getMesh: () => localMesh, onEdge: (e) => localMesh?.adoptInbound(e),
  });
  const { port: localPort } = await localServer.listen(0, "127.0.0.1");
  try {
    localMesh = createMesh({ name: "localbox", nodes: () => ({ g: { host: "127.0.0.1", port: g.port, token: TOKEN } }) });
    const edge = await localMesh.ensureEdge("g");
    assert.ok(edge, "the local daemon holds an edge to g");

    // Grab a port nothing listens on: direct dial refuses.
    const dead = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const handle = await openRemoteSession({
      host: "127.0.0.1", port: dead, token: TOKEN, provider: "deepseek",
      route: { target: "g", local: { host: "127.0.0.1", port: localPort, token: TOKEN } },
    });
    const r = await handle.send("via relay");
    assert.equal(r.text, "echo:via relay", "the session runs on g, reached through the local mesh");
    await handle.close();
    localMesh.stop();
  } finally { await localServer.close(); await g.server.close(); }
});

test("node/forward refuses with ROUTE_UNAVAILABLE naming what was tried", async () => {
  let mesh = null;
  const server = createNodeServer({
    token: TOKEN, name: "lone", cpuSampleMs: 0, deps: fakeDeps(),
    getMesh: () => mesh, onEdge: (e) => mesh?.adoptInbound(e),
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    mesh = createMesh({
      name: "lone", nodes: () => ({}),
      connect: () => Promise.reject(Object.assign(new Error("nope"), { code: "CONNECT_TIMEOUT" })),
    });
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    await assert.rejects(
      conn.request("node/forward", { target: "ghost", method: "node/status", params: {} }),
      (e) => e.code === "ROUTE_UNAVAILABLE" && /ghost/.test(e.message),
    );
    conn.close();
    mesh.stop();
  } finally { await server.close(); }
});

test("node/status reports the node identity and its mesh edges", async () => {
  let mesh = null;
  const server = createNodeServer({
    token: TOKEN, name: "visible", cpuSampleMs: 0, deps: fakeDeps(),
    getMesh: () => mesh, onEdge: (e) => mesh?.adoptInbound(e),
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    mesh = createMesh({ name: "visible", nodes: () => ({}) });
    const conn = await connectNode({ host: "127.0.0.1", port, token: TOKEN });
    const st = await conn.request("node/status", {});
    assert.equal(st.identity.fingerprint, mesh.identity.fingerprint);
    assert.deepEqual(st.mesh.edges, []);
    conn.close();
    mesh.stop();
  } finally { await server.close(); }
});

// localIdentity(): the MCP/console side also presents the machine identity.
test("localIdentity loads the machine identity once per process", () => {
  const a = localIdentity();
  assert.equal(a.fingerprint, localIdentity().fingerprint);
});
