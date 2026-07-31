// engine/node-tls.mjs — TLS-PSK parameters shared by the node server and client.
//
// The LAN node transport is TLS with a pre-shared key derived from the fabric token —
// real TLS encryption + mutual authentication with zero certificates to manage (the token
// already syncs to every machine via claude_env_settings.json). A peer with the wrong
// token fails the handshake itself; nothing is ever exchanged in cleartext.

import crypto from "node:crypto";

export const PSK_IDENTITY = "fabric-node";
// PSK ciphersuites are TLS1.2-named in OpenSSL; pin the version so both ends negotiate it.
export const PSK_CIPHERS = "PSK-AES256-GCM-SHA384";
export const PSK_TLS_VERSION = "TLSv1.2";

/** Derive the 32-byte PSK from the shared fabric token. */
export const pskFromToken = (token) => crypto.createHash("sha256").update(String(token)).digest();
