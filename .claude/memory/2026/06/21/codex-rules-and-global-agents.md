---
name: codex-rules-and-global-agents
description: Codex doesn't auto-load .claude/rules (bridge via rem SessionStart inject-rules hook) and its global instructions file is ~/.codex/AGENTS.md (link GLOBAL-AGENTS.md there too)
metadata:
  type: gotcha
---

# Codex: `.claude/rules` injection + global AGENTS.md

Two Codex-host gaps fixed on 2026-06-21 while porting cc-market plugins.

## 1. Codex does NOT auto-load `.claude/rules/`

Claude Code natively injects every `.claude/rules/**/*.md` each session; Codex has no such
mechanism. Bridge it at the **plugin level**, not per-project:

- `rem/scripts/inject-rules.js` — a `SessionStart` hook that, **only under Codex**, globs the
  host project's `.claude/rules/**/*.md` and emits them via
  `hookSpecificOutput.additionalContext`. Ships once in rem's `hooks.json`; works for any
  project Codex opens. No-op under Claude Code (already auto-loaded → would duplicate).
- Host detection uses the resolved `${CLAUDE_PLUGIN_ROOT}`: Codex substitutes it beneath
  `.codex/plugins/…`, Claude beneath `.claude/plugins/…` (`isCodexHost()`).
- Why rem owns it: rem already manages the rules lifecycle and crystallizes memory into the host
  project's `.claude/rules/rem/` — exactly the content that would otherwise be invisible.
- Tests: `rem/tests/inject-rules.test.mjs`.

## 2. Codex's global instructions file is `~/.codex/AGENTS.md`

Confirmed from the Codex 0.140.0 binary: strings `"Failed to read global AGENTS.md
instructions from"` + `"Files called AGENTS.md commonly appear … at "/", in "~""`. So Codex
reads `$CODEX_HOME/AGENTS.md` as global guidance (mirrors `~/.claude/CLAUDE.md` for Claude).

`GLOBAL-AGENTS.md` is the single source — `setup.js` `CODEX_LINKS` now symlinks it to BOTH
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Before this, GLOBAL-AGENTS.md had no effect
under Codex.

> Broad dual-host design + phased plan: see `2026/06/21/codex-support.md` (relocated from the
> former top-level `CODEX-SUPPORT.md`).
