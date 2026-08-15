---
name: fabric-node-send-async-ack
---

# fabric `node/send` async ack + `node/turn` — kills the 120s remote-turn timeout

**Context (the bug):** fabric's LAN `node/send` returned only after the WHOLE turn completed
(`node-server.mjs` did `return _sendToSession(...)`), and the client used the default 120s
request deadline. A remote turn >~2 min (enroll, uv upgrade, index queries) therefore tripped
`-32000 node request node/send timed out after 120000ms` — a spurious failure; the peer kept
running and finishing. The wall existed only on the REMOTE path; the local `open-session.mjs`
`sendRaw` has no per-turn deadline.

**Fix (committed 7e533bf, fabric v0.2.5):**
- `node/send {id, prompt}` → `{accepted:true, seq}` immediately (fire-and-forget). Outcome is
  stored per `id:seq` in `turnResults`; a stale turn's settle never clobbers a newer one.
- New `node/turn {id, seq}` → `{state: pending|done|error|idle, text?, turn?, error?}`;
  consumes the result on a done/error read; ownership-gated like send/close; cleaned on
  node/close.
- Client `remoteHandle.send()` acks (`SEND_ACK_TIMEOUT_MS` 30s) then polls `node/turn`,
  bounded by `SEND_TURN_TIMEOUT_MS` (30 min; env `FABRIC_SEND_TURN_TIMEOUT_MS`) while each
  poll RPC waits only `TURN_POLL_REQUEST_TIMEOUT_MS` (30s). Wedged session → `TURN_TIMEOUT`;
  dead peer → `CONNECTION_LOST`. `{text, turn}` handle contract unchanged, so
  sendToSession/MCP/console all inherit the fix.

**Deploy + verify (2026-08-15):** pushed; WS2 updated to v0.2.5 and restarted. Cross-machine
E2E from dev client → WS2 new server: quick PONG roundtrip 4.1s, and a 152.8s turn returned
`LONG_DONE` with no timeout (the old code would have failed at 120s).

**Caveat:** new client needs new server (`node/turn`); old fleet peers report `Method not
found: node/turn`. Both sides of a pair must be on the new version.
