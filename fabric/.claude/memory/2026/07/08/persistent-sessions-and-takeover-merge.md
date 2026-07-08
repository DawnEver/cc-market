---
name: persistent-sessions-and-takeover-merge
tier: short
created: 2026-07-08
---

# Persistent sessions over MCP + the takeover/fabric merge question

## Persistent sessions shipped — the server IS the daemon

The roadmap framed `spawn_session`/`session_send`/`session_close` as blocked on a
"handle-holding daemon (MCP calls are discrete; the process must outlive them)". That premise
was wrong: **an MCP stdio server is already long-lived** — it stays up for the whole host
session, so it can hold live session handles in memory across discrete `tools/call`
invocations. No separate daemon process. The daemon *is* the MCP server.

Built:
- `shared/session.mjs` — in-process registry (`createSession`/`sendToSession`/`closeSession`/
  `listSessions`, `_resetRegistry` test hook) + `openProviderSession` dispatcher. Handles stay
  inside the registry; callers reference them only by id.
- `shared/codex/session.mjs` `openCodexSession` — persistent codex thread: one `thread/start`,
  then one `turn/start` per send on the same threadId (codex is natively multi-turn). Same
  `{ id, send(text)→{text,turn}, close() }` surface as the claude `openSession`, so the
  registry holds either provider uniformly. `extractItemText` exported from `codex/task.mjs`.
- fabric `mcp-server.mjs` — 4 new tools, all with injectable `deps` for hermetic tests.

Validated live (real codex binary): spawn → "secret word is PLUMERGE" → next turn recalled
`PLUMERGE` → close. Context retained across separate tool calls. 261 unit tests green
(registry + codex session with fakes; mcp dispatch with dep injection; bundle-integrity).

Codex was the original motivation ("can codex keep context across turns?") — run_task is
one-shot/stateless; these session tools are the stateful answer, and codex works because its
app-server thread is inherently multi-turn.

Not yet exposed: `observe` for session backends is plumbed to `openSession` but the codex
branch ignores it (codex is native — never rides the observe proxy, per the standing invariant).

## Should takeover and fabric merge? — No. Extract, don't merge.

Considered seriously (backward-compat is a non-concern here, so a merge was on the table).
Conclusion: **keep two plugins; the real remaining duplication is the MCP transport, extract
that.**

- The heavy duplication is already gone: both consume the one canonical `shared/` engine layer
  (spawn-child, codex, anthropic-http, providers, and now session). fabric = **mechanism**
  (provider routing + engines + observe proxy + sessions); takeover = **policy** (modes
  task/review/agent/image, prompt shaping, command-block parsing, MCP result skills/commands/
  agents, traceme emission). The `harness-as-fabric` + `engines-into-shared` memos deliberately
  chose mechanism/policy separation.
- Different audiences: fabric is a pure MCP substrate an orchestrator (claude *or* codex)
  drives; takeover carries user-facing skills/commands/agents. Merging bloats each face with
  the other's concern (observe-proxy internals into takeover, or image/review policy into
  fabric).
- What genuinely still duplicates: ~140 lines of hand-rolled JSON-RPC stdio transport
  (`encodeRpcMessage`/`send`/`handleRpcRequest`/framed+line parsing) copied in both
  `mcp-server.mjs`. **Right move: extract `shared/mcp-rpc.mjs`** (transport + dispatch loop;
  each server passes its own `TOOLS` + `handleToolCall`). That captures the last real dup while
  preserving the layering. Not done in this change — flagged as the next slice.

## SUPERSEDED same day — first-principles: converge to ONE call surface

The "keep two plugins" conclusion above was still reasoning from *"two tools exist"*, not from
user need. Re-derived from scratch (user pushback): the atomic operation is a single primitive
**`invoke(model, input, options) → output`**. "takeover single task" = call it once; "orchestrate
many" = call it N times. **Single-vs-many is NOT a design axis — it's just call count**, and
fan-out is the *caller's* job (the agent / a Workflow), not a tool's. Neither plugin actually
orchestrates today; the agent does, via repeated tool calls. So `call_model` and `run_task` are
**the same operation** split only by history (takeover predates fabric; fabric grew from the
cc-lab harness).

The real axes are all *parameters* on that one call, never separate tools: state (one-shot /
persistent — one-shot = a degenerate single-turn session), policy (raw / review / image / agent
= pre-call prompt+endpoint choice), write, observe, result shaping. The mechanism/policy split is
correct **internally** (`shared/` engines vs policy modules) but must not surface as two
user-facing "run a model" tools.

Target shape: one plugin, one mechanism (`shared/`), one call surface (`call` + `session.*`,
one-shot as sugar over open+send+close), modes as options, fan-out delegated to the harness.
takeover's review/image/commands/subagent/traceme survive as optional policy+ergonomics layers
**on the same primitive**. This retracts the "do NOT merge" verdict. Next concrete step: unify
`call_model` ∪ `run_task` into one tool (sessions already built), fold review/image into its
`mode` param. Not yet executed — pending user go-ahead.
