---
description: first-principles gap analysis and target architecture for fabric as the L0 session layer under the swarm framework -- P0 Windows spawn bug, honesty/capacity/profile/durability gaps, the four target surfaces, and the foundation-first iteration order; written for user review
---

# Design: fabric's gaps and target architecture (for review, 2026-08-09)

Context: fabric is L0 of the three-layer stack (fabric → swarm → project; see
motronics-studio `design-three-layer-decoupling-fabric-framework-project.md`). Its ONE
question: *"how do I hold a conversation with a model process, here or on a peer box?"*
Everything below is derived from four properties that question demands, checked against
the code and a live probe (2026-08-09: providers OK; TLS node RPC OK; `spawn_session`
EINVAL local AND remote on Windows; WS1/WS2 servers not running).

## The four first principles

1. **Uniformity** — one handle `{id, send, close}` regardless of provider (claude/codex/
   API) or location (local/peer). Largely achieved; it is fabric's best property.
2. **Honesty** — every answer about a session or node is a fact, never an assumption:
   alive-or-not, where, doing-what-since-when. A transport that cannot tell you a child
   died has failed at transport.
3. **Policy at the spawn point** — what a child MAY do (tools, permissions, env,
   credentials) is fixed when it is created, mechanically. The spawn point is the only
   place subtraction cannot be bypassed.
4. **Facts for the layer above** — fabric REPORTS (ids, liveness, capacity, cost facts);
   it never DECIDES (no queues, no retries, no scheduling). Retry/requeue is swarm's.

## Gap census against the principles

| # | gap | principle violated | evidence |
|---|---|---|---|
| G0 | `spawn EINVAL`: persistent sessions broken on Windows — `open-session.mjs:54` spawns the CLI without `shell:true`/`.cmd` resolution (Node ≥20.12 rejects) | uniformity (the session surface does not work at all on this OS) | live probe: local and remote both fail; one-shot `call` works (raw HTTP) |
| G1 | `node/status` returns `{name, sessions}` only — no cpu/mem/slots/tags/versions | facts (scheduler above is blind) | node-server.mjs:10 |
| G2 | no spawn profiles — children inherit ambient credentials and full tool surface; env shaping is provider routing only | policy at spawn | spawn-child.mjs env audit |
| G3 | liveness is implicit — child death surfaces only on next send; no last-activity, no pid/native-id exposure, no `ping` | honesty | session registry is a Map of handles |
| G4 | no session journal — MCP server or serve.mjs restart forgets every session; layer above cannot even RECONCILE (kill-or-adopt) | facts | in-process registry only |
| G5 | connection loss reaps remote sessions but reports nothing structured to the caller | honesty | node-client pendings reject with generic error |
| G6 | serve.mjs is run-by-hand; no service/autostart story, no self-report of its own version/uptime | honesty (operational) | probe: all 3 configured nodes dead; same registered-but-never-ran shape as the CI runner finding |
| G7 | no cost/usage facts per call/turn (tokens, duration) surfaced on the handle | facts | result text only |
| G8 | no Windows CI for the spawn paths — G0 could regress silently | (meta: the guard) | tests are POSIX-run |

Explicitly NOT gaps (they belong to swarm, do not build here): task queues, claims,
worktree lifecycle, result schemas, requeue/retry, watchdogs, scheduling.

## Target architecture — four surfaces, nothing else

```
┌────────────────────────────────────────────────────────────────┐
│ INVOKE   call(provider, prompt, opts) → {text, usage}          │  one-shot
│ SESSION  open(provider, {profile, node, project, cwd})         │  persistent
│            → {id, send, close}                                 │
│ NODE     serve (TLS-PSK) · status → {name, version, uptime,    │  peers
│            cpu, mem_available, sessions[], tags}               │
│ FACTS    sessions() → [{id, provider, node, pid, native_id,    │  read-only
│            started, last_activity, alive, usage}]              │
│          journal: append-only jsonl of spawn/close/loss events │
└────────────────────────────────────────────────────────────────┘
  invariants: one handle shape everywhere · facts never decisions ·
  policy only at spawn · every failure is a structured report
```

- **INVOKE / SESSION** are the existing surfaces, kept; SESSION gains `profile` — a named
  spawn policy `{allowed_tools, permission_mode, env_allowlist}` defined in config;
  callers name a profile, fabric enforces it (roles are the caller's vocabulary).
- **NODE** keeps the message-passing-only model (a peer is a teammate, never a
  filesystem). `status` becomes the capacity fact the layer above schedules on.
- **FACTS** is the new read-only surface: liveness by real probe (pid alive + transport
  responsive), the journal enabling post-restart reconcile — fabric answers "what did I
  spawn and is it alive"; swarm decides what to do about it.

## Iteration order — foundations strictly first

Each step lands with its test in fabric's node:test suites; G8's Windows job lands WITH
step 1, or step 1's fix is unguarded.

1. **G0 + G8**: fix the spawn (audit every `_spawn` site: open-session, node-server child
   path, codex paths) + a Windows spawn test. Nothing else matters while sessions don't
   open. Acceptance: local and remote `spawn_session` → `send` → `close` round-trip on
   this box.
2. **G3 + G5**: honest liveness — pid/native-id on the handle, `last_activity`, a `ping`,
   structured loss reports. Acceptance: kill a child out-of-band; `sessions()` says dead
   within one probe; remote drop yields a structured event, not a generic reject.
3. **G1**: capacity in `node/status` (+ version/uptime, fixing half of G6). Acceptance:
   the hand-written probe script from 2026-08-09 becomes `fabric ping`, built-in.
4. **G4**: append-only session journal + reconcile query. Acceptance: restart serve.mjs
   with a live child; the journal names the orphan; swarm-side code can kill-or-adopt.
5. **G2**: spawn profiles. Acceptance: a `no-main-token` profile provably lacks the env
   var and the denied tools, asserted by the child itself in a test.
6. **G6** (ops half, REVISED by user directive 2026-08-09): serve is SESSION-BOUND like
   motronics' ci_loop — **never a background service, no autostart, on purpose** (an
   operator terminal owns it; closing the window stops it). Deliverable instead:
   `serve.ps1` / `serve.cmd` / `serve.sh` quick-start scripts + `serve --status`.
7. **G7**: usage facts on handles and in the journal.

After step 7 fabric is "fleet-grade transport" and all further fleet capability goes into
swarm, not here. The review question for the user: agree the four surfaces are the FINAL
fabric (i.e. everything else is swarm's), and agree the order 1→7. **Approved 2026-08-09,
with one revision: serve is session-bound like ci_loop, never a background service.**

## Execution record (2026-08-09, all steps DONE)

| step | commit | acceptance evidence |
|---|---|---|
| 1 G0+G8 | `aa4849a` | two defects: `.cmd` spawn (2 sites → resolveClaudeExe) AND missing `--verbose` (latent on every OS — sessions had NEVER worked on this CLI); live local FABRIC-SESSION-OK + remote FABRIC-REMOTE-OK via node G |
| 2 G3+G5 | `df46eb5` | pid/alive/lastActivity + stderr tail in mid-turn errors (the bare "exit 1" had hidden the --verbose root cause); pingSession, node/ping, CONNECTION_LOST code |
| 3 G1+G6 | `bf59306` | node/status {version,uptime,cpu,mem,tags}; scripts/ping.mjs (probe promoted to built-in); serve --status; live: ALIVE v0.1.9 cpu=32 |
| 4 G4 | `cdb978b` | ~/.fabric/journal.jsonl spawn/close/loss; reconcile() with pid liveness; tests isolate the dir |
| 5 G2 | `ba70fa8` | profiles: allowedTools/permissionMode/envDeny, subtraction-only, resolved once, forwarded to remote peers; MCP spawn_session takes profile |
| 6 G7 | `c201c9b` | usage on handle/listSessions/journal; live deepseek: 27394/2 tokens $0.137, zero orphans after close |

Suite: 237 tests, 0 fail.

**Fleet first-light (same day):** all three nodes ALIVE at once — G cpu=32, WS1 cpu=32,
WS2 cpu=24/30GB free — `ping.mjs` exit 0, and live remote round trips on BOTH peers
(FABRIC-WS1-OK pid 1568, FABRIC-WS2-OK pid 35592). One operational lesson recorded in
README setup: Windows blocks inbound 7677 by default and the symptom is deceptive (serve
log healthy, every peer times out); the New-NetFirewallRule step is now step 3 of setup.

Remaining OPERATIONAL: serve.tags per box (declare femm etc.); swarm-side reconcile
consumer; keep the three serve terminals open (session-bound by directive).

## Same-day extensions (user directives + sharp-review)

Sharp-review of the G0-G8 batch: 22 findings, 5 HIGH — all HIGH closed in `2dca8bd`
(peer-side profile NAME enforcement, extraArgs cannot override profile flags, reconcile
never pid-checks remote sessions, failed closes journal close_failed, plus win32
case-insensitive envDeny / profiled-write safe default / alive never true-by-default).
Then three user-directed features, each live-verified:

* **visible:true** — transcript viewer terminal on the machine running the session
  (windowsHide stays the default; the viewer is a window onto the session, never the
  session). UTF-8 both ends (`fbe432e`).
* **interactive:true** — ONE chat window: streaming transcript + typed interjections;
  the human is ANOTHER SENDER through the same serialized send chain, labelled [human].
  Proved live twice: checkpoints correctly summarized the human's interjections
  (`48cd169`, `1d8bf96`).
* **effort** — the third spawn axis (provider + model + effort): low/medium/high/max or
  a token number → MAX_THINKING_TOKENS, wired through node/spawn + MCP (`ef3ecc2`).
* serve is IDEMPOTENT (second start detects the live node via its own token, exits 0)
  and remains session-bound; MEDIUM/LOW review findings remain open in
  cc-market/.claude/memory/2026/08/09/sharp-review.md for a later pass.

Suite: 246 tests, 0 fail.
