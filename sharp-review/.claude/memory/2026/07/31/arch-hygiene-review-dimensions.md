---
name: arch-hygiene-review-dimensions
description: "Built-in architecture profile reviewScope extended (global) with rules/memory-boundary, suppression-audit, import-architecture dimensions"
metadata:
  type: project
---

sharp-review/scripts/lib/profiles.mjs — BUILT-IN `architecture` profile reviewScope extended 6 -> 9 items (GLOBAL: applies to every repo's architecture survey). cc-market's local .claude/sharp-review.json arch-hygiene was left at its original 6 items to avoid duplication.

1. Rules-vs-memory boundary — AGENTS.md + every scope .claude/rules/*.md hold ONLY core dev principles; mechanism/schema/edge-cases/one-off decisions -> memory (progressive disclosure). Grounding: sharp-review/AGENTS.md = 119 lines (over 100-line threshold), rem/AGENTS.md = 95, invariants 78-90 lines — all always-injected per session.
2. Suppression abuse — # noqa / type: ignore / eslint-disable / @ts-ignore / pylint|ruff|mypy disable used to escape checks. Grounding: suppressions only in watch/ (Python), mostly scoped (E402/T201/type:ignore[code]); type: ignore[call-arg]/[arg-type]/[possibly-unbound] in watch/scripts/helpers/start-server.py and watch/core/{actions,pidfile}.py deserve scrutiny.
3. Import architecture — map import graph: circular imports, barrel (lib.mjs) re-export cycles, cross-module/plugin boundary violations. Grounding: no cross-plugin source imports (sharing via bundled shared/, 51 refs); one stale worktree leftover at .claude/worktrees/agent-a5a6504c62ff45634 (cleanup candidate).
