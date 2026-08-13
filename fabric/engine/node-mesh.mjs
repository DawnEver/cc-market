// engine/node-mesh.mjs — the mesh keeper (P1+P2): every node tries to hold ONE live edge
// to every other configured node, and the dial DIRECTION is a runtime property, never a
// requirement. Reachability on a real network is asymmetric (campus ACLs measured
// 2026-08-13: nothing reaches G inbound, G dials everyone fine), so:
//
//   - outbound: each keeper tick dials every configured peer we hold no edge to
//     (short deadline; failure is recorded for status, not fatal);
//   - inbound:  the node-server hands every accepted edge here (adoptInbound); a peer
//     that can reach us identifies itself by the hello handshake, no config needed.
//
// Either way the edge is SYMMETRIC (node-edge.mjs): once up, both ends can request.
// Two consequences that define correctness:
//
//   DEDUPE. If both ends can dial, both will. Exactly one edge may survive a pair: the
//   one dialed by the lexicographically SMALLER node name. Both sides run the same rule
//   on the same facts (each edge is inbound or outbound; the dialer is me or the peer),
//   so they converge without negotiation.
//
//   FORWARD (node/forward). A console that cannot reach node X asks the LOCAL daemon to
//   relay: the daemon looks up its edge to X (dialing on demand if missing) and passes
//   the request through. The forwarded request carries the token the edge itself uses,
//   so auth at X is unchanged; ownership at X belongs to the edge (the relaying node is
//   the principal — spawn shared sessions if they must outlive it).

import { loadOrCreateIdentity, trustPeer } from "./node-identity.mjs";

export const KEEPER_INTERVAL_MS = 15_000;
export const DIAL_TIMEOUT_MS = 3_000;

/**
 * @param {object} opts
 *   name        this node's name
 *   nodes       () => { peerName: {host, port, token, fingerprint?} } — re-read each tick
 *   connect     injectable (tests): async ({host, port, token, pinnedFingerprint}) → edge-like
 *               ({request, close, onClose, destroyed, peer, peerReady}); defaults to node-client
 *   intervalMs  keeper cadence
 *   identity    {name, publicKey, privateKey, fingerprint} — default: loadOrCreateIdentity()
 *   onRequest   (method, params) → result — requests arriving on OUR outbound edges
 *               (reversal: the peer asks us back over the socket we dialed). Typically
 *               the node-server's serveRequest.
 */
export function createMesh({ name, nodes, connect = null, intervalMs = KEEPER_INTERVAL_MS, identity = null, onRequest = null } = {}) {
  if (!name) throw new Error("createMesh: a node name is required");
  if (typeof nodes !== "function") throw new Error("createMesh: nodes (a function) is required");
  const self = { ...(identity ?? loadOrCreateIdentity()), name }; // the hello must carry OUR name — an adopted inbound edge registers under it
  const edges = new Map();       // peerName → {edge, direction: 'out'|'in', token, since, via}
  const pendingDials = new Map(); // peerName → promise (no duplicate dials per tick)
  const dialErrors = new Map();   // peerName → last error message (status evidence)
  let timer = null;
  let _connect = connect;

  const defaultConnect = async ({ host, port, token, pinnedFingerprint }) => {
    if (!_connect) {
      const { connectNode } = await import("./node-client.mjs");
      _connect = (o) => connectNode({
        ...o, connectTimeoutMs: DIAL_TIMEOUT_MS, identity: self,
        trustPeer: (n, fp) => trustPeer(n, fp, o.pinnedFingerprint ?? null),
        ...(onRequest ? { onRequest } : {}),
      });
    }
    return _connect({ host, port, token, pinnedFingerprint });
  };

  function register(edge, direction, peerName, token = null) {
    const prev = edges.get(peerName);
    if (prev && !prev.edge.destroyed) {
      // The surviving edge of a pair is the one DIALED BY the lexicographically smaller
      // node — on my side that edge's direction is 'out' when I am the smaller, 'in'
      // when the peer is. Both sides run the same rule on the same facts, so the two
      // ends converge without any negotiation.
      const wantedDir = name < peerName ? "out" : "in";
      const keepNew = direction === wantedDir && prev.direction !== wantedDir;
      if (!keepNew) { try { edge.close(); } catch { /* already gone */ } return prev; }
      try { prev.edge.close(); } catch { /* already gone */ }
    }
    const entry = { edge, direction, token, since: Date.now(), via: edge.peer?.via ?? null };
    edges.set(peerName, entry);
    dialErrors.delete(peerName);
    edge.onClose(() => { if (edges.get(peerName) === entry) edges.delete(peerName); });
    return entry;
  }

  /** The server hands every accepted inbound edge here; hello decides if it joins the mesh. */
  function adoptInbound(edge) {
    edge.peerReady.then((r) => {
      if (!r.verified || !r.peer?.name || edge.destroyed) return;
      // A peer that dialed IN still gets requests routed back over this socket — which
      // needs a token the PEER accepts. Take it from our own config for that node name.
      register(edge, "in", r.peer.name, nodes()[r.peer.name]?.token ?? null);
    }).catch(() => { /* a rejected hello never joins the mesh */ });
  }

  /** Dial one peer if we hold no live edge to it. Returns the entry or null (recorded). */
  async function ensureEdge(peerName) {
    if (peerName === name) return null;
    const live = edges.get(peerName);
    if (live && !live.edge.destroyed) return live;
    if (pendingDials.has(peerName)) return pendingDials.get(peerName);
    const spec = nodes()[peerName];
    if (!spec) { dialErrors.set(peerName, "not in fabric.nodes"); return null; }
    const p = (async () => {
      try {
        const edge = await defaultConnect({ host: spec.host, port: spec.port, token: spec.token, pinnedFingerprint: spec.fingerprint ?? null });
        // Wait out the hello so a verified peer name registers the edge; a legacy peer
        // still works for plain requests but cannot be NAMED, so it joins under the
        // configured name — the pin (if any) already vouched for it.
        await edge.peerReady;
        return register(edge, "out", peerName, spec.token);
      } catch (e) {
        dialErrors.set(peerName, `${e.code ? `${e.code}: ` : ""}${String(e.message).slice(0, 200)}`);
        return null;
      } finally { pendingDials.delete(peerName); }
    })();
    pendingDials.set(peerName, p);
    return p;
  }

  /**
   * node/forward: relay one request to a target node over (or via an on-demand dial of)
   * our edge to it. The request's token defaults to the token the edge itself dialed
   * with — auth at the target is exactly what a direct caller would present.
   */
  async function forward(target, method, params = {}, { timeoutMs } = {}) {
    if (!target || typeof target !== "string") {
      throw Object.assign(new Error("node/forward: target (a node name) is required"), { code: -32602 });
    }
    if (target === name) throw Object.assign(new Error(`node/forward: target "${target}" IS this node — call it directly`), { code: -32602 });
    const entry = await ensureEdge(target);
    if (!entry || entry.edge.destroyed) {
      const why = dialErrors.get(target) ?? "no edge and nothing configured";
      const err = new Error(`node/forward: no route to "${target}" from "${name}" (${why}). Inbound edges held: ${[...edges.keys()].join(", ") || "(none)"}`);
      err.code = "ROUTE_UNAVAILABLE";
      err.data = { target, dialError: dialErrors.get(target) ?? null, edges: [...edges.keys()] };
      throw err;
    }
    return entry.edge.request(method, { ...(entry.token ? { token: entry.token } : {}), ...params }, { timeoutMs });
  }

  function status() {
    return {
      name, fingerprint: self.fingerprint,
      edges: [...edges.entries()].map(([peer, e]) => ({
        peer, direction: e.direction, since_s: Math.round((Date.now() - e.since) / 1000),
        verified: !!e.edge.peer, via: e.via, legacy: !!e.edge.legacy,
      })),
      dialErrors: Object.fromEntries(dialErrors),
    };
  }

  function start() {
    if (timer) return;
    const tick = () => { for (const peerName of Object.keys(nodes())) ensureEdge(peerName); };
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick();
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /** Test/observability: a snapshot row per edge (never carries tokens). */
  function edgeList() { return status().edges; }

  return { adoptInbound, ensureEdge, forward, start, stop, status, edgeList, get identity() { return self; } };
}
