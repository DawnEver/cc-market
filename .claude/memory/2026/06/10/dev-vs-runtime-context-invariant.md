---
name: dev-vs-runtime-context-invariant
description: New cross-plugin invariant — plugin CLAUDE.md/AGENTS.md/.claude/rules are dev-only, not injected at skill runtime; fixed inlineDiffLimit drift caused by violating it
---

# Dev context vs. runtime context invariant (2026-06-10)

Added `cc-market/.claude/rules/invariants.md` (new file, cross-plugin, always-injected
when working under `cc-market/`):

- A plugin's `CLAUDE.md`/`AGENTS.md`/`.claude/rules/*` are visible to us while developing
  in this repo, but are NOT injected when the plugin's skill runs in a user's project. At
  runtime a skill only has its own `SKILL.md` + whatever it explicitly `Read`s
  (`reference/*.md`).
- Corollary: each plugin's `.claude/rules/invariants.md` must hold dev-only facts (gotchas,
  ownership, "why"), not user-facing config/behavior — that belongs in `SKILL.md`/
  `reference/*.md`. Two copies of the same fact drift silently because each is invisible
  from the other's vantage point.

## Concrete bug found via this lens

`sharp-review`'s `inlineDiffLimit` default was `20000` in `skills/sharp-review/SKILL.md`
(runtime source of truth) but `40000` in `lib.mjs`/`README.md`/`invariants.md` (dev-only
docs). Correct value is **20000** — fixed `lib.mjs` (`INLINE_DIFF_LIMIT_DEFAULT`),
`tests/manifest.test.mjs`, `README.md`, and trimmed `sharp-review/.claude/rules/
invariants.md` to stop restating the mode/limit details (now points to `SKILL.md`
instead).

## How to apply

When editing any plugin's `invariants.md`/`AGENTS.md`/`CLAUDE.md`, ask: would this fact
need to be true for the skill to work when run by an end user? If yes, it must live in
`SKILL.md` or a linked `reference/*.md`, not (only) in dev docs.
