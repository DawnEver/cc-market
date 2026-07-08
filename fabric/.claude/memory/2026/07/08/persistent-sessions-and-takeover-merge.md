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
**on the same primitive**. This retracts the "do NOT merge" verdict.

## EXECUTED 2026-07-08 — takeover folded into fabric

Plugin name stays `fabric`; the takeover *capability* keeps its name inside it
(`fabric:takeover` subagent, `/fabric:continue`, `fabric:takeover-result` skill).

- **One `call` tool** = `call_model` ∪ `run_task`. `mode` enum (task/review/agent/
  image-generate/image-edit) carries policy; `<command>` flags authoritative; `observe:true`
  (non-codex) forces the harness engine behind the proxy (folds run_task's capture). Dispatch
  matrix (provider bucket × mode) ported verbatim from takeover's handleCallModel →
  `handleCall`. Base = takeover's dual-transport server (line + framed, framed needed for
  Codex) + grafted fabric session/provider tools.
- **Moved into fabric**: `scripts/{lib.mjs,lib/,codex/{review,image}.mjs}`, `prompts/`,
  `agents/takeover.md`, `commands/{continue,models,summary}.md`, `skills/{takeover-result,
  codex-image-result}`, 4 tests. All `../shared/*` imports resolve unchanged (fabric bundles
  shared). SCRIPT_DIR/PROMPTS_DIR resolve to fabric/prompts.
- **Namespace fix (the silent-failure risk)**: sharp-review's 5 hardcoded
  `mcp__plugin_takeover_takeover__call_model` → `mcp__plugin_fabric_fabric__call` (+ agent
  allowlist), else reviewers silently fall back to the flaky Agent path. Done atomically.
  Also fixed the malformed `mcp__takeover__list_models` in models.md → list_providers.
- **Packaging**: `git rm -r takeover/`; dropped its marketplace entry; enriched fabric's;
  `commands` array into fabric plugin.json; regen `gen-codex`; updated pre-commit plugin
  list, `codex-e2e-live.sh` (fabric + list_providers probe), root AGENTS.md + invariants.
- **Validated**: full JS suite 825 pass / 0 fail (incl. bundle-integrity + gen-codex). Live
  `call` on codex returns the computed answer. Codex app-server echoes input text items before
  the answer — a PRE-EXISTING quirk (seen in old run_task too), not a merge regression.

Deferred (next slice): extract `shared/mcp-rpc.mjs` (transport still ~140 lines, but now only
one server uses it, so lower priority); the codex input-echo wart; renaming internal
"mcp-takeover:" stderr prefixes (left to avoid touching the `takeover_traces.jsonl` traceme
contract).
