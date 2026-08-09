// engine/node-tls.mjs — wire parameters shared by the node server and client: the TLS-PSK
// handshake and the framing limits both ends must agree on.
//
// The LAN node transport is TLS with a pre-shared key derived from a fabric token — real
// TLS encryption + mutual authentication with zero certificates to manage (tokens already
// sync to every machine via claude_env_settings.json). A peer with an unaccepted token
// fails the handshake itself; nothing is ever exchanged in cleartext.
//
// A node accepts a SET of tokens so one peer can be revoked without re-keying the fleet
// (SR-051). TLS-PSK carries exactly one PSK per identity, so the identity names WHICH
// token the peer holds: `fabric-node:<sha256(token)[:12]>`. The fingerprint is a hash, so
// the identity — which travels in the clear during the handshake — never reveals the
// credential. PSK_IDENTITY is the pre-fingerprint spelling, still accepted and mapped to
// the node's primary token so an older peer keeps connecting.

import crypto from "node:crypto";

export const PSK_IDENTITY = "fabric-node";
export const PSK_IDENTITY_PREFIX = "fabric-node:";
// PSK ciphersuites are TLS1.2-named in OpenSSL; pin the version so both ends negotiate it.
export const PSK_CIPHERS = "PSK-AES256-GCM-SHA384";
export const PSK_TLS_VERSION = "TLSv1.2";

// Framing limits, enforced on BOTH sides: an unbounded line is a DoS whichever end sends it.
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/** Derive the 32-byte PSK from a fabric token. */
export const pskFromToken = (token) => crypto.createHash("sha256").update(String(token)).digest();

/** Public, non-reversible name for a token — safe to put on the wire and in logs. */
export const tokenFingerprint = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);

/** The PSK identity a peer holding `token` presents. */
export const identityForToken = (token) => `${PSK_IDENTITY_PREFIX}${tokenFingerprint(token)}`;
