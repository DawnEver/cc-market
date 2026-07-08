---
name: codex-mcp-testing-and-engine-deshare
tier: short
created: 2026-07-08
---

# Testing plugin MCP availability inside Codex from Claude Code + fabric engine de-share

Two findings from a session validating `fabric -> codex -> fabric -> (codex+claude+deepseek)`.

## 1. Nested fabric chain works — Codex as a programmable test host

Goal: verify a plugin's MCP is usable *inside Codex* without opening the Codex CLI, driving
it entirely from Claude Code.

- fabric spawns a Codex child via the app-server with **only `cwd`** (`shared/codex/session.mjs`
  `thread/start`). It does **not** forward the caller's MCP servers. The Codex child sees only
  the MCP servers in its own `~/.codex/config.toml`.
- So `fabric -> codex` works out of the box, but the nested `codex -> fabric` hop is dead
  until fabric's MCP server is registered in Codex's own config. First run: the child
  correctly reported "fabric MCP not available".
- Fix — register fabric globally in `~/.codex/config.toml` (absolute path, single-quoted TOML
  literal to survive spaces/backslashes):

  ```toml
  [mcp_servers.fabric]
  command = "node"
  args = ['C:\Users\...\cc-market\fabric\scripts\mcp-server.mjs']
  startup_timeout_ms = 20000
  ```

- Provider keys load from `~/.claude/claude_env_settings.json` via `os.homedir()` (absolute,
  cwd-independent — `shared/providers.mjs`), so the fabric instance Codex spawns still resolves
  deepseek etc. regardless of the child's cwd.
- After registration the full 4-hop chain ran: nested Codex saw `mcp__fabric.call`, fanned out
  three `call`s (codex/claude/deepseek), wrote a per-model-attributed haiku. Each provider hit a
  distinct L1 path (codex app-server / claude `-p` / deepseek raw HTTP).

**Payoff:** to smoke-test whether any plugin's MCP works under Codex, drive
`call(provider="codex", write=true)` from Claude Code and have the child `list MCP tools` /
invoke the tool — Codex becomes a programmable headless test host. Registration is **global**,
so every real Codex session also spawns a fabric MCP server; remove the block if you don't want
it resident. Backup left as `~/.codex/config.toml.bak.*`.

## 2. Fabric engines no longer need to live in `cc-market/shared/`

`shared/` split (see `engines-into-shared` 2026-07-07) was justified by **two** consumers:
fabric + takeover. takeover is now **absorbed into fabric**, so the engine group is
fabric-only. Measured: no non-fabric plugin imports any of it.

`cc-market/shared/` is actually two disjoint groups:

- **A — generic utilities (genuinely multi-plugin):** `lib.mjs` (evolve/rem/sharp-review/
  traceme), `state.mjs` (evolve/rem), `stamp.mjs` (rem), `spawn.mjs` (rem/traceme),
  `attention.mjs` (evolve).
- **B — fabric session/execution engines (fabric-only):** `providers`, `spawn-child`,
  `open-session`, `session`, `anthropic-http`, `observe-proxy`, `observe-reader`, `mcp-rpc`,
  `codex/{app-server,task,session,discovery}`.

`bundle_shared` copies **all** of `shared/` into **every** plugin, so `watch/` (imports nothing
from shared) and the others each carry ~9 dead fabric-engine files, plus the "don't edit the
bundled copy, edit the canonical source, re-bundle" friction.

**Executed (2026-07-08):** group B moved out of `cc-market/shared/` into `fabric/engine/`
(fabric-owned canonical, edited directly), their 8 canonical unit tests moved to
`fabric/tests/` (so the existing `<plugin>/tests/*.test.mjs` glob auto-runs them — no hook/
glob change needed). `cc-market/shared/` now holds only group A. Every plugin's bundled
`shared/` dropped the ~9 group-B files + `codex/`. engine reaches `spawn.mjs` (group A) via
`../shared/spawn.mjs`, so fabric keeps a bundled `shared/`; `usesShared`/bundle-integrity
still pass because that import resolves inside `fabric/shared/`. Rewired imports: fabric
scripts (`mcp-server.mjs`, `lib/{spawn,callers}`, `codex/{image,review}`) + fabric tests →
`../engine/…`. Full suite green (823 tests, 0 fail). Docs updated: fabric AGENTS.md file
structure + L0 line, README L0/L1, invariants "engine/ is canonical, shared/ is a bundled
copy". Dated memory snapshots (harness-as-fabric, engines-into-shared, etc.) left as historical
record — they describe the shared/ layout that was true when written.
