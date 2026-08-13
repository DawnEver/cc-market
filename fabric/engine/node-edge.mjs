// engine/node-edge.mjs — the SYMMETRIC edge: one TLS socket that carries JSON-RPC
// requests in BOTH directions. The pre-mesh fabric had a client side (pending map, sends
// requests) and a server side (dispatch, answers them) — an asymmetry that meant only the
// dialer could ever ask. On a network where inbound reachability is the scarce resource
// (campus ACLs, 2026-08-13: G accepts nothing inbound but dials out fine), the dial
// DIRECTION must be a transport detail, not a capability: whichever side managed to
// connect, both ends can then request.
//
// attachEdge() wraps an established TLS socket with:
//   - the line framing + caps both old sides already shared (MAX_LINE_BYTES on incoming
//     requests, MAX_REPLY_BYTES on outgoing replies — each end enforces both),
//   - a pending map for requests WE send, dispatch via onRequest for requests THEY send,
//   - the identity handshake (P3): both ends send a `node/hello` notification
//     {name, fingerprint, publicKey, nonce} right away and answer a hello with
//     `node/prove` {signature} over a payload binding both nonces AND both fingerprints —
//     replay across sessions fails (nonces), claiming another node fails (fingerprint in
//     the payload, key in the proof). These two methods are RESERVED: the edge consumes
//     them and never passes them to onRequest.
//
// A peer that never says hello is LEGACY (pre-mesh fabric): the edge works exactly as
// before, peer stays null, and `peerReady` resolves {verified:false, legacy:true}. A
// configured PIN turns that from a shrug into a refusal: if you pinned a fingerprint,
// a peer that cannot prove it must not be talked to.

import crypto from "node:crypto";
import { MAX_LINE_BYTES, MAX_REPLY_BYTES } from "./node-tls.mjs";
import { signChallenge, verifyChallenge } from "./node-identity.mjs";

export const HELLO_TIMEOUT_MS = 2000;
const PROOF_PREFIX = "fabric-edge-v1";

const proofPayload = ({ proverFp, verifierFp, proverNonce, verifierNonce }) =>
  `${PROOF_PREFIX}|prover=${proverFp}|verifier=${verifierFp}|pnonce=${proverNonce}|vnonce=${verifierNonce}`;

/**
 * @param {object} opts
 *   socket            established TLS socket (secureConnect already fired, or about to)
 *   label             "host:port" or "ip:port inbound" — for error text only
 *   identity          {name, publicKey, privateKey, fingerprint} or null (anonymous legacy)
 *   pinnedFingerprint expected peer fingerprint; a peer that can't prove it is rejected
 *   trustPeer         (name, fingerprint) → {ok, via, reason?} — pin/TOFU decision
 *   helloTimeoutMs    wait for a hello before declaring the peer legacy
 *   requestTimeoutMs  default per-request deadline
 *   onRequest         async (method, params, edge) → result; throws to send an error reply
 */
export function attachEdge({
  socket, label, identity = null, pinnedFingerprint = null,
  trustPeer = () => ({ ok: true, via: null }),
  helloTimeoutMs = HELLO_TIMEOUT_MS,
  requestTimeoutMs = 120_000,
  onRequest = async () => { throw Object.assign(new Error("this edge does not serve requests"), { code: -32601 }); },
}) {
  const pending = new Map(); // id → {resolve, reject, timer}
  const closeHandlers = new Set();
  let seq = 0;
  let buf = "";
  let deathError = null;
  const lostError = (why) => deathError ?? Object.assign(
    new Error(`node connection lost (${label}): ${why}`), { code: "CONNECTION_LOST" });
  const failAll = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  const fail = (why) => failAll(lostError(why));
  socket.on("error", (e) => { fail(e.message); socket.destroy(); });
  socket.on("close", () => {
    fail("closed");
    for (const fn of closeHandlers) { try { fn(); } catch { /* observer only */ } }
    closeHandlers.clear();
  });

  // ── identity handshake state ──
  const nonce = crypto.randomBytes(16).toString("hex");
  let peerHello = null;      // {name, fingerprint, publicKey, nonce}
  let helloDeadline = null;
  const edge = {
    peer: null,              // {name, fingerprint, verified:true, via} once proven
    legacy: false,
    get destroyed() { return socket.destroyed; },
    request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
      return new Promise((res, rej) => {
        if (socket.destroyed) return rej(lostError("closed"));
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(Object.assign(
            new Error(`node request ${method} timed out after ${timeoutMs}ms (${label})`),
            { code: "REQUEST_TIMEOUT", method }));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    // A notification never gets a reply — used for hello/prove and cheap signals.
    notify(method, params = {}) {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    onClose(fn) { if (socket.destroyed) fn(); else closeHandlers.add(fn); },
    close() { socket.destroy(); },
  };

  let resolveReady;
  edge.peerReady = new Promise((r) => { resolveReady = r; });
  const declareLegacy = () => {
    if (edge.peer || edge.legacy) return;
    edge.legacy = true;
    resolveReady({ verified: false, legacy: true });
  };
  if (pinnedFingerprint) {
    // Fail closed: a pin says "I know exactly who this must be". No hello in time = reject.
    helloDeadline = setTimeout(() => {
      if (!edge.peer) {
        deathError = Object.assign(
          new Error(`peer at ${label} presented no provable identity within ${helloTimeoutMs}ms, but a fingerprint is pinned — refusing to talk to it`),
          { code: "IDENTITY_REQUIRED" });
        failAll(deathError);
        socket.destroy();
        resolveReady({ verified: false, legacy: false, error: deathError.message });
      }
    }, helloTimeoutMs);
    helloDeadline.unref?.();
  } else {
    helloDeadline = setTimeout(declareLegacy, helloTimeoutMs);
    helloDeadline.unref?.();
  }

  if (identity) {
    edge.notify("node/hello", { name: identity.name, fingerprint: identity.fingerprint, publicKey: identity.publicKey, nonce });
  }

  function onHello(params) {
    if (!params?.fingerprint || !params?.publicKey || !params?.nonce) return;
    peerHello = { name: params.name ?? null, fingerprint: params.fingerprint, publicKey: params.publicKey, nonce: String(params.nonce) };
    if (identity) {
      edge.notify("node/prove", {
        signature: signChallenge(identity.privateKey, proofPayload({
          proverFp: identity.fingerprint, verifierFp: peerHello.fingerprint,
          proverNonce: nonce, verifierNonce: peerHello.nonce,
        })),
      });
    }
    // A peer with no identity of its own (legacy client) sends no prove; the verifier
    // side of OUR hello simply never completes in that direction. If they DID hello,
    // they are not legacy — but still must prove when we pinned.
  }

  function onProve(params) {
    if (!peerHello || edge.peer || !params?.signature) return;
    const ok = verifyChallenge(peerHello.publicKey, proofPayload({
      proverFp: peerHello.fingerprint, verifierFp: identity?.fingerprint ?? "",
      proverNonce: peerHello.nonce, verifierNonce: nonce,
    }), params.signature);
    if (!ok) {
      deathError = Object.assign(
        new Error(`peer at ${label} failed the identity proof for ${peerHello.fingerprint} (${peerHello.name ?? "unnamed"})`),
        { code: "IDENTITY_PROOF_FAILED" });
      failAll(deathError);
      socket.destroy();
      resolveReady({ verified: false, legacy: false, error: deathError.message });
      return;
    }
    const decision = trustPeer(peerHello.name, peerHello.fingerprint);
    if (pinnedFingerprint && pinnedFingerprint !== peerHello.fingerprint) {
      decision.ok = false;
      decision.reason = `fingerprint mismatch against the pin: expected ${pinnedFingerprint}, peer proved ${peerHello.fingerprint}`;
    }
    if (!decision.ok) {
      deathError = Object.assign(new Error(decision.reason), { code: "IDENTITY_UNTRUSTED" });
      failAll(deathError);
      socket.destroy();
      resolveReady({ verified: false, legacy: false, error: decision.reason });
      return;
    }
    clearTimeout(helloDeadline);
    edge.peer = { name: peerHello.name, fingerprint: peerHello.fingerprint, verified: true, via: decision.via };
    resolveReady({ verified: true, legacy: false, peer: edge.peer });
  }

  const reply = (rpc) => {
    try {
      let line = JSON.stringify(rpc);
      if (line.length > MAX_REPLY_BYTES) {
        line = JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          error: {
            code: "RESULT_TOO_LARGE",
            message: `node reply for request ${rpc.id} was ${line.length} bytes, over the ${MAX_REPLY_BYTES}-byte cap; the result was not sent`,
            data: { bytes: line.length, maxBytes: MAX_REPLY_BYTES },
          },
        });
      }
      socket.write(`${line}\n`);
    } catch { /* socket gone */ }
  };

  socket.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      deathError = Object.assign(
        new Error(`node response exceeded ${MAX_LINE_BYTES} bytes without a newline (${label})`),
        { code: "RESPONSE_TOO_LARGE" });
      failAll(deathError);
      buf = "";
      socket.destroy();
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let rpc;
      try { rpc = JSON.parse(line); } catch { continue; }
      // Reserved edge methods — consumed here, never dispatched (hello is idempotent-ish:
      // a duplicate just re-arms peerHello; prove after verified is ignored).
      if (rpc.method === "node/hello") { onHello(rpc.params); continue; }
      if (rpc.method === "node/prove") { onProve(rpc.params); continue; }
      if (rpc.id !== undefined && (rpc.result !== undefined || rpc.error !== undefined)) {
        // A reply to one of OUR requests.
        const p = pending.get(rpc.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(rpc.id);
        if (rpc.error) {
          const err = new Error(rpc.error.message || "node error");
          err.code = rpc.error.code;
          if (rpc.error.data !== undefined) err.data = rpc.error.data;
          p.reject(err);
        } else p.resolve(rpc.result);
        continue;
      }
      if (rpc.method !== undefined) {
        // A request (or notification) from the peer.
        const notification = rpc.id === undefined;
        Promise.resolve()
          .then(() => onRequest(rpc.method, rpc.params ?? {}, edge))
          .then(
            (result) => { if (!notification) reply({ jsonrpc: "2.0", id: rpc.id, result }); },
            (e) => {
              if (notification) return;
              const error = { code: e?.code ?? -32000, message: e instanceof Error ? e.message : String(e) };
              if (e?.data !== undefined) error.data = e.data;
              reply({ jsonrpc: "2.0", id: rpc.id, error });
            },
          );
      }
    }
  });

  return edge;
}
