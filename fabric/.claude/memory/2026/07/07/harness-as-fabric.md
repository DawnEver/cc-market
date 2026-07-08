---
tier: short
created: 2026-07-07
accessed: 2026-07-07
access_count: 1
---

# harness-as-fabric design

Design discussion (no code changed) on evolving the cc-lab harness into a
multi-model orchestration fabric: any agent (claude / codex) managing many
independent child sessions of any provider (claude / deepseek / codex).

## Conclusions

1. **Multi-child is already structurally supported.** `driver.mjs` gives each
   child an isolated run dir + `CLAUDE_CONFIG_DIR` + its own PTY. Launch N in
   parallel = fan-out. But the harness is an *observation* tool today, not a
   production orchestrator — queue/scheduling/result-collection/user-input
   escalation must be written in the case (L2b) layer; the driver only exposes 5
   primitives (send/key/waitOutput/waitIdle/close + ready).

2. **DeepSeek is reached via Foundry mode**, not vanilla routing. In
   `~/.claude/claude_env_settings.json` provider `deepseek`:
   `CLAUDE_CODE_USE_FOUNDRY=1`,
   `ANTHROPIC_FOUNDRY_BASE_URL=https://api.deepseek.com/anthropic`,
   `ANTHROPIC_FOUNDRY_API_KEY=sk-...`, with all opus/sonnet aliases mapped to
   `deepseek-v4-pro[1m]` and haiku → `deepseek-v4-flash`.
   **`driver.mjs:129-132` deliberately STRIPS the Foundry env** because
   claude-tap's MITM only intercepts vanilla `ANTHROPIC_BASE_URL`. ⇒ Foundry and
   claude-tap are architecturally mutually exclusive.

3. **takeover plugin already routes claude/codex/deepseek** via `call_model`
   (task/review/agent/image modes) — a *stateless one-shot* handoff. Different
   lifecycle from cc-lab's *persistent* PTY sessions, so don't hard-merge.

4. **Recommended architecture: layered, don't merge.**
   - L0 provider registry = existing `claude_env_settings.json` (single source of
     truth; don't let cc-lab duplicate it).
   - L1 session fabric = extract from driver: `spawnChild(provider,
     {interactive, observe})` — isolated config + env injection + optional observe.
   - L2a takeover `call_model` = stateless consumer (nearly unchanged, slimmed).
   - L2b orchestrator = persistent consumer, shared by cc-lab debug + daily use.
   - Package L1+L2b as a new cc-market plugin (`agent-fabric`/`sessions`); slim
     takeover into a thin consumer. cc-lab becomes a debug-profile user — daily vs
     cc-lab differ only by the `observe` boolean.

5. **Self-built minimal proxy beats claude-tap** for the observe layer: a small
   Node http reverse proxy appending request/response jsonl per session (no
   sqlite / live-view / blob offload). It's **provider-agnostic on the upstream**:
   child always uses vanilla `ANTHROPIC_BASE_URL` → proxy → proxy picks the real
   upstream per provider (deepseek endpoint+key / anthropic oauth). This
   **DISSOLVES the Foundry-vs-tap conflict**: debug = vanilla+proxy (no Foundry
   vars), normal = Foundry direct-connect. The `observe` boolean literally = "use
   vanilla+proxy" vs "use Foundry direct". Only real engineering: provider→
   upstream+auth rewrite mapping + non-buffered SSE forwarding.

6. **codex is the exception** — goes through codex-companion, not
   Anthropic-compatible HTTP, ignores `ANTHROPIC_BASE_URL`. Don't route it through
   the proxy; reuse takeover's codex adapter or codex's own logs for debug.

7. **User-input handling** (child asks a question): the PTY path can't reliably
   detect "this is a question" from the TTY (`stripAnsi` yields word-concatenated
   text). Better: reduce prompts via permission-mode downgrade + explicit prompts
   (default for batch), escalate to the real user as fallback, or use headless/SDK
   mode where `AskUserQuestion` is a structured event. takeover `agent` mode
   already runs the child in the CC harness with structured events.

## Observe-proxy: refined boundary (build a shim, not a tap)

Decision locked: build a minimal Anthropic-compatible reverse proxy as the observe
layer; do NOT hard-depend on claude-tap. It's the agent-fabric observe proxy —
small, session-aware, provider-aware — serving only `spawnChild(..., {observe:true})`.

**Build:** provider→upstream/auth rewrite · per-session jsonl · non-buffered SSE ·
opt-in observe. **Don't build (yet):** UI, sqlite, replay, blob storage, metrics.

Three implementation gotchas that shape the MVP:

1. **model-alias rewrite is a BODY mutation, not a header.** Without Foundry the child
   still sends `"model":"claude-opus-…"`; the proxy must parse the JSON body and remap
   the family (haiku/sonnet/opus) to the registry's real id. ⇒ request/response are
   **asymmetric**: REQUEST is buffered+parsed+mutated (small, non-stream); only the
   RESPONSE (SSE) streams back unbuffered. This asymmetry is the proxy's core shape.
2. **auth forks per provider.** DeepSeek = inject static `x-api-key`. claude = OAuth
   bearer that refreshes ⇒ **passthrough** the child's own header, don't let the proxy
   hold creds (`passthroughAuth` flag).
3. **the `beta=true` quota probe (404)** lands in jsonl too; the reader (not the proxy)
   filters it, per `mainTurns()`.

## Next step — DONE (validated 2026-07-07)

Built `driver/proxy.mjs` (`startObserveProxy({provider, runDir, passthroughAuth})`) +
`cases/proxy-roundtrip.case.mjs`. Real child→proxy→DeepSeek round-trip PASSED:
upstream 200, **SSE arrived in 10 flushes over ~1000ms (proves non-buffering)**,
model-alias rewrite fired (`claude-haiku-4-5` → `deepseek-v4-flash`), `x-api-key`
injection accepted, `http.jsonl` captured request+response. The one true unknown is
closed; the proxy transport works.

Remaining (config, not unknowns): wire `observe` into driver.mjs (vanilla+proxy vs
Foundry direct, replacing the unconditional Foundry-strip at driver.mjs:129-132);
add a jsonl reader mirroring `driver/tap.mjs` (`mainTurns()` filter); then L1/L2
packaging.

## Graduated into cc-market plugin `fabric` (2026-07-07)

The prototype validated here graduated into a real cc-market plugin
(`Sync/claude/cc-market/fabric`, branch `feat/substrate-observe-proxy`,
commit 5a73360). cc-lab's throwaway `driver/proxy.mjs` + `cases/proxy-roundtrip.case.mjs`
were deleted — the productized versions now live in the plugin:

- **L0** `shared/providers.mjs` — provider routing promoted from takeover (single
  source of truth); adds `resolveModelFromId` + `resolveUpstream`. takeover's
  `config.mjs` now re-exports from it (dedupe; 96 tests still green).
- **L1** `shared/observe-proxy.mjs` (the validated proxy), `shared/spawn-child.mjs`
  (`spawnChild(provider,{observe})`; `buildChildEnv` = the Foundry-strip-vs-proxy
  switch), `shared/observe-reader.mjs` (`mainTurns()` filter).
- **Dual form** — importable library + MCP server (`list_providers`, `resolve_model`;
  hand-rolled JSON-RPC, takeover style). Persistent-session MCP tools
  (`spawn_session` etc.) declared as roadmap — they need a handle-holding daemon.
- Tests: providers 8, spawn-child 5, observe-reader 6, observe-proxy hermetic 1
  (fake local SSE upstream, no network/key), bundle-integrity 140. All plugins green.

Design decisions this session: dual-form MCP+library; provider routing promoted to
root `shared/`. cc-lab's PTY driver stays as-is (its job is real-TUI observation, a
different lifecycle from the headless fabric).

Next (open): `spawn_session` daemon for persistent sessions.

## Follow-through (2026-07-07, same day)

The engines-into-shared refactor completed the layering (see cc-market
`.claude/memory/2026/07/07/engines-into-shared.md`): codex adapter and the claude child
engine each have one implementation in root `shared/`; takeover is a pure policy layer.
cc-lab's driver gained `launch({observe: 'tap'|'proxy'|'none'})` — the 'proxy' profile
consumes this plugin's observe-proxy (validated live against DeepSeek,
`cases/observe-proxy-profile.case.mjs`), and the Foundry-strip is now tap-mode-only.
