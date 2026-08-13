// engine/node-identity.mjs — per-node Ed25519 identity (P3). The fleet token is a SYNCED
// file secret: any box (or anyone who has read one config) can present it. A node identity
// key never leaves the machine that generated it, so pinning a node's fingerprint in
// `fabric.nodes.<name>.fingerprint` — or trusting it on first use (TOFU) — separates
// "holds the fleet token" from "IS the machine it claims to be".
//
// The proof rides the TLS-PSK channel (node/hello + node/prove in node-edge.mjs): after
// secureConnect both ends already share an authenticated encrypted channel, so a
// challenge signature binds the identity to the connection. What this layer does NOT yet
// change is the channel itself — PFS requires TLS1.3 with certificates, a follow-up; the
// identity layer is designed so that swap does not touch fingerprints or pins.
//
// Storage (journalDir(): FABRIC_JOURNAL_DIR in tests, ~/.fabric otherwise):
//   identity.json      { publicKey, privateKey, fingerprint, created }   (mode 0600, best-effort)
//   known-peers.json   { <name>: { fingerprint, firstSeen, lastSeen } }  (TOFU cache)
// A pinned fingerprint (config) ALWAYS beats the TOFU cache; a mismatch against either is
// a hard failure — that is the one event this layer exists to make impossible to miss.

import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journalDir } from "./journal.mjs";

export const FINGERPRINT_PREFIX = "ed25519:";

/** Public, non-secret name for a public key — goes on the wire, into configs and logs. */
export function fingerprintOfPublicKey(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return FINGERPRINT_PREFIX + crypto.createHash("sha256").update(der).digest("hex").slice(0, 24);
}

function identityPath() { return join(journalDir(), "identity.json"); }
function knownPeersPath() { return join(journalDir(), "known-peers.json"); }

/**
 * This machine's identity, generating and persisting one on first use.
 * Returns { publicKey, privateKey, fingerprint, created } (PEMs + fingerprint).
 */
export function loadOrCreateIdentity() {
  const p = identityPath();
  try {
    const saved = JSON.parse(readFileSync(p, "utf8"));
    // Recompute, never trust the cached fingerprint field: the key pair is the fact.
    const fingerprint = fingerprintOfPublicKey(saved.publicKey);
    // Validate the pair actually works before anyone pins it.
    const sig = crypto.sign(null, Buffer.from("fabric-identity-selftest"), saved.privateKey);
    if (!crypto.verify(null, Buffer.from("fabric-identity-selftest"), saved.publicKey, sig)) throw new Error("identity self-test failed");
    return { publicKey: saved.publicKey, privateKey: saved.privateKey, fingerprint, created: saved.created ?? null };
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) {
      // A CORRUPT identity is not silently rotated: a new key is a new node to every peer
      // that pinned the old one. Say so loudly, then regenerate — the alternative (refuse
      // to start) bricks the node on a truncated file.
      process.stderr.write(`fabric identity: ${p} unreadable (${e.message}); generating a NEW identity — peers with the old fingerprint pinned will reject this node\n`);
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" });
  const priv = privateKey.export({ type: "pkcs8", format: "pem" });
  const identity = { publicKey: pub, privateKey: priv, fingerprint: fingerprintOfPublicKey(pub), created: new Date().toISOString() };
  mkdirSync(journalDir(), { recursive: true });
  try { writeFileSync(p, JSON.stringify(identity, null, 2), { mode: 0o600 }); }
  catch { writeFileSync(p, JSON.stringify(identity, null, 2)); } // mode is best-effort on Windows
  return identity;
}

/** Sign the peer's hello challenge with this identity. Payload shape is node-edge's concern. */
export function signChallenge(privateKeyPem, payload) {
  return crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");
}

/** Verify a proof against the public key a hello advertised. */
export function verifyChallenge(publicKeyPem, payload, signatureB64) {
  try {
    return crypto.verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(String(signatureB64), "base64"));
  } catch { return false; }
}

/**
 * Trust decision for a peer's advertised fingerprint.
 * @param name     configured node name (or null for an inbound stranger)
 * @param fingerprint  advertised "ed25519:..." fingerprint
 * @param pinned   fingerprint from fabric.nodes.<name>.fingerprint, if configured
 * Returns { ok, via: 'pinned'|'tofu-known'|'tofu-new'|null, reason? } — and records
 * tofu-new peers in known-peers.json. A CHANGED fingerprint (pin or cache) is never ok.
 */
export function trustPeer(name, fingerprint, pinned = null) {
  if (typeof fingerprint !== "string" || !fingerprint.startsWith(FINGERPRINT_PREFIX)) {
    return { ok: false, via: null, reason: `malformed fingerprint: ${String(fingerprint).slice(0, 40)}` };
  }
  if (pinned) {
    return pinned === fingerprint
      ? { ok: true, via: "pinned" }
      : { ok: false, via: null, reason: `fingerprint mismatch against the config pin for "${name}": expected ${pinned}, peer presented ${fingerprint}` };
  }
  const known = readKnownPeers();
  const prev = name ? known[name] : null;
  if (prev && prev.fingerprint !== fingerprint) {
    return { ok: false, via: null, reason: `fingerprint for "${name}" CHANGED: first seen as ${prev.fingerprint} (${prev.firstSeen}), now ${fingerprint}. If this node was re-keyed on purpose, remove the entry from ${knownPeersPath()} or pin the new fingerprint in fabric.nodes` };
  }
  if (!prev && name) {
    known[name] = { fingerprint, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() };
    writeKnownPeers(known);
    return { ok: true, via: "tofu-new" };
  }
  if (prev) {
    prev.lastSeen = new Date().toISOString();
    writeKnownPeers(known);
  }
  return { ok: true, via: "tofu-known" };
}

/** The TOFU cache, tolerant of absence/corruption (corruption = empty cache, all peers re-TOFU). */
export function readKnownPeers() {
  try { return JSON.parse(readFileSync(knownPeersPath(), "utf8")); } catch { return {}; }
}

function writeKnownPeers(known) {
  try {
    mkdirSync(journalDir(), { recursive: true });
    writeFileSync(knownPeersPath(), JSON.stringify(known, null, 2));
  } catch { /* a TOFU cache that cannot persist degrades to re-asking — never fatal */ }
}
