---
name: engines-into-shared
tier: short
created: 2026-07-07
---

# Engines into shared/ — fabric/takeover dedup completed

Completed the layering the `harness-as-fabric` memo (fabric/.claude/memory/2026/07/07)
started: **all L1 execution engines have exactly one home, `cc-market/shared/`; fabric and
takeover are policy consumers.**

## What moved

- `shared/codex/{app-server,task,discovery}.mjs` — was copy-forked in
  `takeover/scripts/codex/` and `fabric/scripts/codex/` (identical except the hardcoded
  client-name string). The client now self-identifies via `resolveClientInfo()` — a walk-up
  to the nearest `.claude-plugin/plugin.json` from the entry script. takeover keeps only
  its policy adapters `scripts/codex/{review,image}.mjs`.
- `shared/spawn-child.mjs` — unified claude child engine. Absorbed takeover
  `spawnClaudeP`'s hard-won pieces: Windows `resolveClaudeExe()` (npm-prefix walk; spawn
  shell:false can't run `claude.cmd`), stream-json stdin for >1000-char prompts/images,
  abort signal, unref'd kill timer, usage extraction. `runDir` is now optional — with it
  you get fabric-style isolated `CLAUDE_CONFIG_DIR` (+ optional observe proxy), without it
  takeover-style "run against the caller's own credentials".
- `shared/anthropic-http.mjs` — raw single-turn HTTP caller (retry + SSE), promoted from
  takeover `callers.mjs`. It is NOT duplication of spawn-child: `mode=task` for API
  providers = raw completion (no CC harness/tools); `mode=agent` = full CC harness.
  Three engines, three semantics: CC harness / raw HTTP / codex app-server.

## Model resolution rule (spawn-child)

Direct-connect API provider + model → exact env pin `ANTHROPIC_MODEL` via
`resolveModel` (tier words / provider ids) or `resolveModelFromId` (full `claude-*` ids);
`--model` flag only for native claude or observe mode (the proxy remaps the body).

## Bundling

`bundle_shared` (pre-push) and `tests/bundle-integrity.test.mjs` are now recursive
(`shared/codex/` subdir), excluding `shared/tests/`. Re-bundle command used manually:
`(cd shared && find . -name tests -prune -o -name '*.mjs' -print0 | tar --null -T - -cf - | tar -C ../<plugin>/shared -xf -)`.

## Relationship one-liner

fabric owns the session mechanism (L0 routing + L1 engines + observe proxy, canonical in
root `shared/`); takeover is its most important user-facing policy (modes, prompts, MCP
result shaping). cc-lab stays an out-of-repo PTY lab; its only planned coupling is an
optional observe-proxy debug profile.
