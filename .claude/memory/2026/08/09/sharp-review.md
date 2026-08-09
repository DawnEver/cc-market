---
name: sharp-review-2026-08-09
description: Sharp review findings — 56 total
metadata:
  type: project
---


## Review 2026-08-09 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped
- Reviewer kimi (kimi): skipped

### Confirmed findings

---

### [SR-20260809-001] [HIGH] fabric/engine/node-server.mjs — The peer applies a CLIENT-SUPPLIED profile object verbatim and never consults its own fabric.profiles — remote 'enforcement at the peer's spawn point' is caller-controlled, i.e. no enforcement at all

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** node/spawn should accept a profile NAME only, resolve it against the server's own fabric.profiles, reject inline objects, and apply a server-side defaultProfile when none is named. Test: client sending an inline profile object must be rejected with -32602.

node/spawn does profile: params.profile ?? null and passes it straight into _createSession. resolveProfile is never called on the server; loadFabricConfig is never imported by node-server.mjs. session.mjs claims 'the peer enforces it at ITS spawn point' — the peer obeys, it does not enforce. Any client holding the shared PSK token can send {allowedTools:'Bash', permissionMode:'bypassPermissions', envDeny:[]} or omit profile entirely and get a full-write child on the peer with the peer's credentials.

---

### [SR-20260809-002] [HIGH] fabric/engine/profile.mjs — "A profile only ever subtracts" is false — a profile can ADD Bash and set bypassPermissions, and extraArgs override the profile flags anyway

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Put profileArgs after extraArgs or strip --allowedTools/--permission-mode/--dangerously-* from extraArgs when a profile is present; add the test that plants those flags in extraArgs and asserts the profile wins; validate permissionMode against an enum; reword the comment (policy SET, not subtraction).

(1) The non-write openSession path previously passed no tool/permission flags; profileArgs now injects --allowedTools and --permission-mode, so {allowedTools:'Bash,Write', permissionMode:'bypassPermissions'} is a privilege ESCALATION through the mechanism documented as subtraction-only; permissionMode is passed through unchecked. (2) In open-session.mjs the arg order is ...profileArgs(profile), ...hookFreeArgs(extraArgs), ...extraArgs — the CLI takes the last occurrence, so extraArgs:['--permission-mode','bypassPermissions'] silently overrides the profile, directly under the comment claiming the spawn point cannot be bypassed.

---

### [SR-20260809-003] [HIGH] fabric/engine/journal.mjs — reconcile() checks a REMOTE session's pid against the LOCAL process table, and PID reuse makes pidAlive:true an invitation to kill an unrelated process

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** If ev.node is set, return pidAlive: null (probe the peer via node/ping). For local records, record start-time or boot-id alongside pid and require both to match; treat records older than uptime as dead. Document the three states alive/dead/unknowable.

createSession journals pid: handle.pid — for a remote handle that is the child's pid on the PEER — yet reconcile() does process.kill(pid, 0) locally and never looks at ev.node. The journal has no age bound; after a reboot pids are recycled, so a stale spawn record names an unrelated process and the docstring's advice is 'kill or adopt'. The test only exercises an injected _pidAlive stub, covering neither the remote case nor pid reuse.

---

### [SR-20260809-004] [MEDIUM] fabric/engine/node-client.mjs — request() has NO timeout — CONNECTION_LOST covers a peer that drops, never a peer that accepts and goes silent

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a per-request timeout (default ~30s, overridable for node/spawn/node/send) rejecting with code:'REQUEST_TIMEOUT', plus TCP keepalive; make ping.mjs use Promise.allSettled with its own deadline. Test: accept-then-silent server must reject within the deadline.

connectTimeoutMs guards only the TLS handshake. request() writes a line, parks a promise in pending, and waits forever. A wedged peer never errors the socket, so fabric ping hangs indefinitely on the exact failure it exists to detect — and ping.mjs probes nodes sequentially, so one wedged node blocks the whole report.

---

### [SR-20260809-005] [MEDIUM] fabric/engine/session.mjs — alive: h.alive ?? true reports true unconditionally for write, codex and remote handles — three of four backends report liveness by wishful default

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Every handle declares its liveness semantics: alive: null for stateless backends plus a kind field ('stateless'|'child'|'remote'); pingSession catches remote failure and returns {alive:false, reason}. Add the negative test: ping on a write session must not claim alive:true.

Only openSession defines an alive getter. openWriteSession has no persistent child (fresh claude -p per turn) — 'alive' is a category error there, yet ping answers true. Codex handles: true. A remote handle forwards ping(), but if the peer is unreachable pingSession REJECTS rather than reporting alive:false. listSessions says null where ping says true — the two shapes disagree. The feature is titled 'honest liveness — reported, never inferred'; ?? true is inference in the optimistic direction.

---

### [SR-20260809-006] [MEDIUM] fabric/engine/journal.mjs — Append-only journal with no rotation, no size bound, and a full-file synchronous read on every reconcile

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rotate at a size ceiling and read only from the last rotation boundary, or checkpoint the open set periodically; state the bound in the header comment.

recordEvent appends to ~/.fabric/journal.jsonl forever; readJournal reads the entire history into memory and reconcile replays every event since installation. A fan-out workload makes reconcile progressively slower and the file unbounded.

---

### [SR-20260809-007] [MEDIUM] fabric/engine/journal.mjs — Both journal write and read fail SILENTLY — a swallowed spawn append or torn line makes a live session vanish from reconcile, the one thing the journal exists to prevent

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** A failed spawn-append should warn loudly on stderr and be counted; readJournal should report unparseable-line count so reconcile can say 'N events unreadable — list may be incomplete'.

recordEvent wraps everything in catch {}; readJournal drops unparseable lines. A spawn append that fails (disk full, EPERM, torn concurrent append from two MCP server processes — appendFileSync is not guaranteed atomic on Windows) leaves a running child with NO record; reconcile reports zero orphans. A torn close line makes a finished session an eternal orphan. Neither direction tested; multi-process concurrency unconsidered.

---

### [SR-20260809-008] [MEDIUM] fabric/engine/open-session.mjs — The stderr tail flows into Error messages sent to another model and journaled to disk — a child that echoes an API key in its error now leaks it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Scrub provider env values from the tail before surfacing; never journal a raw stderr tail. Use Buffer.concat().subarray(-N).toString('utf8') so the name matches the unit.

errTail (last 4096 of raw child stderr) is interpolated into the rejection message, which propagates to the MCP tool result and is journaled via recordEvent({event:'loss', reason: e.message}). Children routinely spill env/config into stderr on startup failure (bad ANTHROPIC_AUTH_TOKEN, proxy URL with inline credentials). Also (errTail + d).slice(-4096) implicitly toString()s each Buffer chunk at arbitrary boundaries corrupting multibyte UTF-8, and 4096 is a character count despite the name STDERR_TAIL_BYTES.

---

### [SR-20260809-009] [MEDIUM] fabric/engine/profile.mjs — envDeny does exact-case key deletion, but Windows env vars are case-INSENSITIVE — envDeny:['SECRET_TOKEN'] does not remove Secret_Token

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Match case-insensitively (lowercase key index); add the test planting Secret_Token and denying SECRET_TOKEN; consider warning when a denied var is absent so a typo'd entry doesn't look identical to a successful subtraction.

for (const k of profile.envDeny) delete out[k] is exact-match against a {...process.env} copy. On Windows (the primary platform) a var set as Integrator_Token survives an envDeny:['INTEGRATOR_TOKEN'] and reaches the child, which reads it case-insensitively. The test asserts only the exactly-matching case. A security control that silently no-ops.

---

### [SR-20260809-010] [MEDIUM] fabric/engine/session.mjs — openWriteSession keeps bypassPermissions as the default even when a profile restricts allowedTools — a half-applied profile is worse than none

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** When a profile names no permissionMode, default to 'default' (prompting); intersect allowedTools with the backend default. Test both backends with the same profile and assert identical capability sets.

const permissionMode = profile?.permissionMode || 'bypassPermissions'. A profile {allowedTools:'Read,Grep'} (the module's own doc example) restricts the tool list but leaves the child in bypassPermissions. Also a profile's allowedTools REPLACES the write default Bash,Read,Write,Edit,Glob,Grep but is a pure addition on the non-write path — one key, two opposite semantics depending on backend.

---

### [SR-20260809-011] [LOW] fabric/engine/session.mjs — Remote sessions never journal usage, and only CONNECTION_LOST is recorded as a loss — every other death leaves a permanent phantom orphan

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Have node/close return the remote handle's usage; journal a loss whenever a local handle reports alive === false at any observation point; distinguish null from {unavailable:true}.

closeSession journals usage: entry.handle.usage ?? null; the remote handle exposes no usage and node/close returns only {id, exitCode, turns}, so cost facts are null for exactly the distributed fan-out the accounting was added for. The loss event fires only on e.code === 'CONNECTION_LOST' inside sendToSession; a local child dying between turns produces no loss record and its spawn line stays open forever.

---

### [SR-20260809-012] [LOW] fabric/engine/open-session.mjs — Usage accounting ignores cache tokens, so any scheduler budgeting on input_tokens undercounts by whatever fraction is cached

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Accumulate cache fields separately and expose total_input_tokens; set partial: true when a result event carries no usage.

usage.input_tokens += ev.usage?.input_tokens ?? 0 drops cache_creation_input_tokens and cache_read_input_tokens, typically the dominant input term for a long session. cost_usd is right; token facts are a systematic undercount growing with session length. The test feeds only input/output tokens so the omission cannot be caught.

---

### [SR-20260809-013] [LOW] fabric/engine/node-server.mjs — node/ping is deliberately not owner-restricted, so any authenticated peer can probe sessions belonging to another connection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either scope both node/status and node/ping to the owned set, or document the node as a single trust domain where the token confers full visibility.

node/send and node/close enforce owned.has(params.id); node/ping skips it citing node/status — an argument for tightening node/status, not widening ping. The ownership model is stated in two places and enforced in one.

---

### [SR-20260809-014] [LOW] fabric/scripts/serve.mjs — --status prints 'serving: no (nothing answered)' for ANY failure, including wrong token or TLS mismatch — the diagnostic lies in exactly the case you'd run it for

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Print the caught error's code: 'serving: unknown (<code>)' for auth/TLS, reserving 'serving: no' for ECONNREFUSED.

The bare catch collapses ECONNREFUSED, timeout, PSK auth failure and protocol error into one 'not serving' message. A node under a stale token reports as down; the operator starts a second server (EADDRINUSE) or reschedules its work. ping.mjs's slice(0,120) truncation can cut the informative part of a TLS error.

---

### [SR-20260809-015] [LOW] fabric/tests/profile.test.mjs — The added tests systematically test the happy direction; every negation that would catch the findings above is absent

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** For each HIGH/MEDIUM finding the failing test is 3-10 lines. Move the stray import to the top.

No test that node/spawn rejects a client-supplied profile; that extraArgs cannot override profile flags; that a profile-restricted write session isn't left in bypassPermissions; case-mismatched envDeny; a hung accept-then-silent peer; journal corruption/rotation/concurrent append; reconcile with a remote pid; ping on a stateless write session. Minor: profile.test.mjs puts an import on the LAST line of the file.

---

### [SR-20260809-016] [HIGH] fabric/engine/session.mjs:132 — Failed or timed-out closes are falsely journaled as successful closes

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Record close only after confirmed process exit; preserve or terminate a handle on timeout, and record a distinct close-failure/loss event.

closeSession() deletes the registry entry and records 'close' in finally, even if handle.close() throws. openSession.close() also returns after an eight-second timeout without killing the child. A still-running child can lose its only handle while reconciliation suppresses it as already closed.

---

### [SR-20260809-017] [HIGH] fabric/engine/open-session.mjs:57 — Caller arguments can override the supposedly non-bypassable spawn profile

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Reject profile-related flags in extraArgs, or validate duplicates and apply enforced profile arguments last.

profileArgs(profile) is placed before extraArgs. A later --allowedTools or --permission-mode overrides the profile, contradicting the security claim that policy attaches at a spawn point that cannot be bypassed.

---

### [SR-20260809-018] [MEDIUM] fabric/engine/session.mjs:82 — Codex sessions silently ignore resolved profiles

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Map profile restrictions into the Codex backend, or explicitly reject profiles for Codex.

The profile is resolved before backend dispatch, but the Codex branch passes only model, write, cwd, and _client. Tool and permission restrictions are silently discarded.

---

### [SR-20260809-019] [MEDIUM] fabric/engine/session.mjs:188 — Team workers cannot receive spawn profiles

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Pass profile: w.profile through createTeam() and cover it in the team API schema and tests.

createTeam() reconstructs worker options without profile, so team workers silently run under default permissions even when their worker declaration includes a profile.

---

### [SR-20260809-020] [MEDIUM] fabric/engine/session.mjs:160 — Ping reports unobserved sessions as alive

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return null/unknown when liveness is unavailable, or implement real liveness reporting on every handle.

The fallback uses h.alive ?? true. Both write-session and Codex handles lack alive, so the liveness endpoint fabricates true, directly violating its reported-not-inferred contract.

---

### [SR-20260809-021] [MEDIUM] fabric/engine/journal.mjs:19 — Journal failures and corrupt records are silently erased

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Expose persistence health or emit a structured warning, and report corrupt rows instead of silently dropping them.

recordEvent() swallows every write failure and readJournal() drops every malformed line. A failed spawn write makes a live orphan permanently invisible, so this cannot reliably serve as the claimed fact record.

---

### [SR-20260809-022] [MEDIUM] fabric/engine/session.mjs:77 — Named profiles ignore the caller's configuration path

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Resolve profiles with loadFabricConfig(opts.configPath).

openProviderSession() loads profiles from the global default config while forwarding opts.configPath to provider environment loading. A caller can load credentials and profiles from different files, producing the wrong policy or an unexpected unknown-profile error.


## Review 2026-08-09 (follow-up)

## Review 2026-08-09 (session) — architecture review (manual scope: fabric plugin at 100-agent scale)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): OK
- Reviewer kimi (kimi): OK

### Confirmed findings

---

### [SR-20260809-023] [HIGH] fabric/engine/node-client.mjs — request() has no per-request timeout: a session_send to a hung or dead remote session hangs the MCP tool call forever.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a per-request timeout (e.g. 120s) with a structured REQUEST_TIMEOUT code that rejects the pending entry and marks the remote session lost.

connectNode() only times out the TCP connect. Once the socket is up, request() pushes {resolve,reject} into pending and awaits forever. On the peer, node/send awaits handle.send() which awaits the claude stream-json child; a hung child never emits a result, so no reply arrives and the pending entry is never settled. The serialized chain in open-session.mjs makes this head-of-line: one hung turn blocks all later turns on that session. G5 structured loss only covers socket drop, not a live socket with a silent peer.

---

### [SR-20260809-024] [HIGH] fabric/engine/session.mjs — write:true claude sessions route to openWriteSession: a fresh claude -p process plus the FULL accumulated history re-sent every turn — O(n^2) tokens and one claude.exe boot per turn.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Make the persistent stream-json openSession carry write capability so write-mode workers retain context in-process; stop accumulating and re-sending the whole transcript.

openProviderSession routes write to openWriteSession, which keeps history in memory; each send() rebuilds prompt = history.join and spawns a brand-new claude.exe to reprocess the entire conversation. At 100 agents 7x24 a 50-turn write worker re-pays 50x the context and the fleet constantly spawns/tears down ~100MB children. Persistent write sessions are simply not built.

---

### [SR-20260809-025] [HIGH] fabric/engine/node-server.mjs — node/spawn has zero admission control: mem_available_mb is reported but nothing ever refuses a spawn — a peer holding the shared token can fork-bomb a box with claude.exe children.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** ARCHITECTURE CONFLICT: fabric records facts, not decisions, but its own spawn path ignores the capacity fact it reports. Surface the conflict: either a floor-refusal (capacity FACT) or an atomic capacity claim the swarm must take; add a hard per-connection/per-node session cap regardless.

node/status reports cpu/mem_available_mb/mem_total_mb (G1) so the layer above can admit, but node/spawn ignores every one of them: any authenticated peer may spawn unlimited sessions. At 100-agent scale a runaway swarm or one buggy fan_out OOMs the box. This is the one place fabric would have to grow a decision (refuse) to be safe — flagged per the constraint, not silently built.

---

### [SR-20260809-026] [HIGH] fabric/engine/session.mjs — Profiles are resolved then silently dropped on the codex path: openCodexSession has no profile parameter, so a restrictive spawn profile is not enforced for codex sessions.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Pass profile into openCodexSession and enforce allowedTools/permissionMode/envDeny at the codex spawn, or refuse profile+codex combinations you cannot enforce.

openProviderSession resolves profile and passes it to the claude/write/remote paths, but calls openCodexSession({model, write, cwd, _client}) with NO profile. codex/session.mjs defines no profile handling at all — write:true codex sessions run with the full ambient credential set and full tool surface regardless of the named profile. The remote path forwards profile to node/spawn, which re-resolves and drops it again on codex. Design claims policy at the spawn point (G2) but the codex spawn point does not enforce it.

---

### [SR-20260809-027] [HIGH] fabric/engine/node-client.mjs — One TCP connection per remote session with no heartbeat: 100+ sessions means 100+ TLS sockets, and a dead/half-open peer is discovered only on the next send, which then hangs.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Multiplex multiple sessions over one pooled connection per peer (the pending-map already supports request multiplexing), and add a periodic node/ping heartbeat that reaps stale sockets.

openRemoteSession does connectNode() per session; each socket gets a fresh pending-map/buf/seq. At 100 remote sessions across 3 nodes that is 100+ TLS sockets plus 100 owned sets on the servers. No TCP keepalive, so a half-open connection does not fire close for a long time; the session is reaped only on next send, and that send hangs. node/ping exists but nothing calls it periodically.

---

### [SR-20260809-028] [MEDIUM] fabric/engine/journal.mjs — The journal is a single append-only file with no locking, appended by every journaling process (MCP server, serve.mjs, consoles) and read in full on every reconcile; never rotated.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Per-process journal files or an append-time advisory lock; add rotation/compaction; make reconcile read only the tail or keep an offset.

recordEvent() does appendFileSync to ~/.fabric/journal.jsonl from any process. Concurrent writers can interleave long JSON lines; readJournal() silently drops unparseable lines (try/catch flatMap), losing events without a trace. reconcile() reads the ENTIRE file and replays spawn/close/loss each call; at 100 sessions 7x24 the file and reconcile cost grow unbounded. The single-writer assumption is unstated and false in the target deployment.

---

### [SR-20260809-029] [MEDIUM] fabric/engine/node-server.mjs — node/status serializes the full session registry (including usage) on every poll; a fleet console polling every 6s x N nodes x 100 sessions re-serializes everything each time.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return a light summary (id/provider/turns/alive) in node/status; separate richer call for usage.

node/status calls _listSessions() mapping every registry entry including usage objects. A 6s fleet poll across 100 sessions and 3 nodes produces 300 full-descriptor serializations/min — an O(active sessions) control loop coupled to working-set size.

---

### [SR-20260809-030] [MEDIUM] fabric/engine/node-client.mjs — The client response buffer is unbounded: buf += chunk with no cap, unlike the server MAX_LINE_BYTES.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Mirror the server MAX_LINE_BYTES guard on the client read loop and drop/close on overflow.

node-server.mjs caps inbound at MAX_LINE_BYTES but the node-client data handler has no bound. A session_send with resultMode:full can return a very large line; a misbehaving peer can stream indefinitely. The DoS guard exists on one side only.

---

### [SR-20260809-031] [MEDIUM] fabric/engine/session.mjs — createTeam spawns workers strictly sequentially, and a mid-way spawn failure leaks the already-created sessions (in sessions Map but never in the team map).

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Spawn workers in parallel (Promise.all) and on any failure close already-spawned workers before throwing.

createTeam loops await createSession per worker; the teams map is only set after the loop. If worker k throws, workers 0..k-1 remain registered but are unreachable by closeTeam and leak as live claude.exe children until server restart. Team spawn latency is serial x boot time.

---

### [SR-20260809-032] [MEDIUM] fabric/engine/session.mjs — getTeamStatus calls listSessions() once per worker — O(workers x sessions) per team_status; team_send calls it too.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Call listSessions() once, build an id-index, look up workers against it.

For each worker: const all = listSessions(); all.find(...). At 100 workers x 100 sessions that is 10,000 linear scans per status call.

---

### [SR-20260809-033] [MEDIUM] fabric/engine/node-tls.mjs — A single shared PSK authenticates the whole fleet, every peer uses fixed identity fabric-node, node port binds 0.0.0.0, checkServerIdentity disabled.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Per-node tokens (node.token already overrides fabric.token — default it on) and distinct identities so the server can attribute connections.

The server pskCallback cannot distinguish who is connecting, only that they hold the token, which syncs to all machines via claude_env_settings.json. A compromise of any one box yields impersonation plus the ability to spawn sessions with every box credentials.

---

### [SR-20260809-034] [MEDIUM] fabric/engine/open-session.mjs — openSession never cleans up its tmpdir runDir (config dir + observe http.jsonl) on close — sessions leak directories indefinitely.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Remove the runDir in close(), or garbage-collect fabric-session-* temp dirs on next launch.

close() ends stdin and closes the observe proxy but never removes runDir. With observe:true, http.jsonl captures full traffic. At 100 sessions 7x24 OS tmp fills with fabric-session-* dirs; nothing reclaims them.

---

### [SR-20260809-035] [LOW] fabric/engine/journal.mjs — recordEvent does recursive mkdirSync + appendFileSync on every event — synchronous disk on the event loop hot path.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** mkdir once at module load; queue appends asynchronously.

Under bursty spawn/close each event is a synchronous disk syscall blocking the MCP server entire request loop; a slow home dir serializes all tool calls behind the journal.

---

### [SR-20260809-036] [LOW] fabric/engine/node-server.mjs — The server writes unbounded responses (full session result) with no size cap on the reply side.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Cap node/send result size at the wire.

reply() does socket.write(JSON.stringify(rpc)) with no length guard; the MCP layer truncates but the node layer does not — the server-side counterpart of the missing client buffer cap.

---

### [SR-20260809-037] [LOW] fabric/engine/session.mjs — Teams are not journaled: a server restart loses team membership while the underlying sessions are recoverable via the journal.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Journal team create/close events so reconcile can surface orphaned workers whose team is gone.

teams is in-process only; after a restart the children still run, reconcile finds them as orphans, but swarm cannot know they were a team. The fact of team membership is not recorded anywhere durable.

---

### [SR-20260809-038] [LOW] fabric/engine/session.mjs — The feared in-process session-registry races do not exist: Node is single-threaded, Map operations are atomic between await points.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document that the real concurrency hazards are cross-process (journal) and remote-socket state, not the in-process Map.

sessions/teams Maps are touched from one thread only. The genuine races are the multi-process journal append, close racing an in-flight send on node-server, and the remote pending-map.

---

### [SR-20260809-040] [HIGH] fabric/engine/session.mjs — Concurrent sends to one session interleave for remote/write handles: no per-session send mutex in the registry; the open-session single pending slot means the second send overwrites the first resolve/reject and one caller turn is lost or hangs.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Serialize sends per session id in sendToSession (promise chain keyed by id, mirroring open-session own chain), or reject a send while one is in flight with a structured code.

open-session.mjs and codex/session.mjs serialize internally, but openRemoteSession and openWriteSession have NO serialization: two concurrent session_send calls to the same remote id both issue node/send; server-side both hit the SAME open-session child whose module-level pending is a single slot — the second overwrites the first, one promise never settles until the child closes. The MCP transport dispatches tool calls concurrently, so this is reachable with zero exotic timing; at 100-agent scale with teams fanning turns it is a certainty, not a race.

---

### [SR-20260809-041] [HIGH] fabric/engine/node-server.mjs — No admission control on node/spawn: any token-holder can fork-bomb the box; the MCP-side 8-slot limiter does NOT exist in the node server — dispatch() fires every request unbounded. Architecture conflict: refusing is arguably swarm job.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Flag the boundary: a static operator-declared ceiling (serve.maxSessions in config) refused past and reported in node/status is a declared invariant, not a scheduling decision. Dynamic admission stays in swarm.

Each spawn is a claude.exe child (~100-200MB RSS). 100 sessions plus parents is roughly 20GB+ on a 32GB box before context buffers. A peer being able to kill the machine is a safety bound, not a scheduling decision.

---

### [SR-20260809-042] [HIGH] fabric/engine/session.mjs — Codex sessions silently ignore spawn profiles — policy-at-spawn has a hole exactly where the most capable provider lives.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Pass profile into openCodexSession and map allowedTools/permissionMode onto the codex sandbox config, or refuse provider=codex with a profile until mapped (a named hole, not a silent one).

session.mjs:83 drops the resolved profile on the floor. A caller naming profile no-main-token gets full ambient credentials and tools with no error — the guard-scope-lies shape: the MCP schema claims profile applies to spawn_session generally and one provider path routes around it.

---

### [SR-20260809-043] [HIGH] fabric/engine/node-client.mjs — request() has no timeout: a hung peer wedges the caller serialized send chain AND holds an MCP limiter slot forever — 8 wedged calls exhaust FABRIC_MCP_MAX_CONCURRENCY and the whole MCP server stops answering.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Per-request timeout (caller-overridable) rejecting with a TIMEOUT code distinct from CONNECTION_LOST so swarm can tell peer-gone from peer-stuck.

pending entries are only removed on response or socket close. TLS stays up across an alive-but-wedged peer (open-session close has an 8s guard but send() has none). The caller chain then blocks ALL subsequent sends to that session permanently. Reliability cliff at 7x24.

---

### [SR-20260809-044] [HIGH] fabric/engine/journal.mjs — Journal: single append-only file written by every fabric process with no lock and no idempotency — concurrent appends can tear on Windows, torn lines are silently dropped by readJournal, and reconcile() does a full-file read.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Per-process journal files (journal-<pid>.jsonl) with reconcile merging, or an advisory lock per append (shared/lock.mjs exists). Track an offset or compact on close events.

appendFileSync from multiple processes has no line-integrity guarantee on Windows; a torn write lands mid-line and the JSON.parse catch drops it — losing exactly the spawn record reconcile needs to find an orphan. The design defers kill-or-adopt to swarm but gives swarm a corruptible fact base.

---

### [SR-20260809-045] [MEDIUM] fabric/engine/session.mjs — Session registry is process-local with no cross-process identity: multiple fabric processes per box hold disjoint registries; reconcile reports orphans by child pid but cannot say which registry process still holds the handle, so adopt is impossible and kill risks a live session.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Make the journal the join point: record which process owns each id so swarm can route close/ping to the right daemon.

Each Claude host session spawns its own fabric MCP server; serve.mjs is another. The journal records facts but not enough of them for the decision it explicitly defers upward.

---

### [SR-20260809-046] [MEDIUM] fabric/engine/node-server.mjs — node/status returns the full session list on every call and is not owner-filtered: any token-holder sees every session pid, cwd-implied project and activity on the box.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Compact mode (counts + id/alive/lastActivity, no usage objects) or a since/cursor; document O(sessions) cost.

With console polling every few seconds x 100 sessions x 3 nodes, status becomes the dominant control-plane traffic; a single shared PSK means one leaked config exposes the whole fleet observability and control plane.

---

### [SR-20260809-047] [MEDIUM] fabric/engine/open-session.mjs — Per-session cost is a full claude.exe child; no shared-runtime option and no cap, and the resource fact surface is incomplete: node/status reports box-level mem, not per-session RSS, so a scheduler places sessions blind until the box thrashes.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Report per-session RSS in the liveness facts (pid is already there) so swarm admission has the real number; long-term a pooled runtime is the only scaling answer.

100+ concurrent sessions = 100+ node.exe processes (roughly 10-20GB RSS); the practical fleet ceiling is RAM, discovered by OOM. The numbers needed to admit safely are not the numbers reported.

---

### [SR-20260809-048] [MEDIUM] fabric/engine/node-client.mjs — One TCP connection per remote session: linear fd/handle cost, and lifecycle coupling — socket drop = session death with no reattach; a 2-second LAN blip kills all sessions on that connection.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Share one connection per host:port, multiplex by JSON-RPC id (protocol already supports it); server-side per-connection ownership is the actual blocker — move ownership to a per-session token or accept same-peer shared ownership. Add a reattach path.

node-server reaps owned ids on connection close. At 7x24 a transient network blip turns into 40 lost agent contexts; no heartbeat detects a half-dead connection before the next send.

---

### [SR-20260809-049] [MEDIUM] fabric/engine/session.mjs — openWriteSession passes the ENTIRE history as one argv prompt — quadratic token cost AND a ~32k Windows argv ceiling that kills a write session with a spawn error around turn 5-10; defaults are the widest possible (bypassPermissions + Bash/Write/Edit).

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move the prompt to stdin (spawn-child already has a useStdin path for >1000 chars); cap or summarize history; do not default to bypassPermissions — require the profile to widen.

history.join passed as an argv element to claude.exe; Windows CreateProcess command line limit is about 32k chars. The one session type marketed as write-capable defaults to the opposite of the G2 subtraction principle.

---

### [SR-20260809-050] [MEDIUM] fabric/engine/mcp-rpc.mjs — The 8-slot limiter gates all tool calls uniformly: cheap ops (list/ping/close) queue behind multi-minute model turns; close behind a stuck send cannot even cancel your way out.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Two pools: heavyweight (call/fan_out/session_send) bounded; lightweight (list/ping/close/status) separately bounded or unbounded.

Under load, session_close sits in the limiter queue behind the wedged send holding the last slot — a liveness problem, not just latency.

---

### [SR-20260809-051] [MEDIUM] fabric/engine/node-tls.mjs — Single fleet-wide PSK in a synced plaintext config is the only credential: no per-node identity, no revocation short of re-syncing every machine.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Server accepts a SET of accepted peer tokens so a peer can be revoked by removing one entry; per-node tokens already exist in config — make them the norm. Identity policy sits above fabric — flag, do not expand scope.

checkServerIdentity disabled is fine for PSK (the handshake authenticates); the crypto is adequate — the issue is key management. Every box, backup and config dump carries the fleet master key.

---

### [SR-20260809-052] [MEDIUM] fabric/engine/open-session.mjs — send() to a dead-but-not-yet-closed child can hang: closed is only set on close/error events; a write to stdin of an out-of-band-killed child succeeds into a pipe that never answers — no per-turn timeout.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Optional per-turn timeoutMs on send() rejecting with TURN_TIMEOUT; combined with the client-side fix this closes both ends of the hang.

The chain design means one wedged turn bricks the session for every later caller. The G3 liveness promise holds only if someone probes; an in-flight send at the moment of death hangs silently.

---

### [SR-20260809-053] [LOW] fabric/engine/node-config.mjs — loadFabricConfig caches by mtimeMs with 1s Windows granularity and never expires; a same-second config edit is invisible to long-lived daemons.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Short TTL in addition to mtime, or bigint-ns stat.

A profile tightened mid-session may silently not apply until mtime ticks past the cached value.

---

### [SR-20260809-054] [LOW] fabric/engine/codex/app-server.mjs — Codex pool: withPooledClient acquire has no timeout (asymmetric with withSharedClient lock timeout); a leaked fn(client) holds its slot forever, waiters queue unboundedly.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Report pool waiter count in a status surface so a saturated pool is an observable fact; the per-request 600s timer mitigates most cases.

Mostly defended by the 600s request timer, hence LOW, but the asymmetry is worth one line of observability.

---

### [SR-20260809-056] [INFO] fabric/engine/session.mjs — Genuine strengths to preserve: uniform id/send/close handle across local/remote/codex; serialized per-child turn chains; CONNECTION_LOST as structured loss with journal events; per-connection ownership with reap-on-drop; the MCP limiter bounding fan-out from one host.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** No action — these are the load-bearing choices the fixes above should preserve.

The architecture (facts not decisions, message-passing only, ownership reaping) is coherent; the HIGH findings are holes in that honesty under concurrency, not the shape being wrong.
