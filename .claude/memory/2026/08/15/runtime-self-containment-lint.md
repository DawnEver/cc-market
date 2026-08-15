---
name: runtime-self-containment-lint
---

# cc-market runtime self-containment audit + evolve fix + pre-commit lint

**Principle (already in cc-market invariants, was not enforced):** `AGENTS.md` / `CLAUDE.md` /
`.claude/rules/` are injected only in the DEV repo. When a skill actually runs, it sees only
its own `SKILL.md` + the `reference/*.md` it reads + the host project's `.claude/`. So a
runtime file must never defer to a bare `AGENTS.md §` / `CLAUDE.md §` — that knowledge never
reaches the runtime agent.

**Audit (2026-08-15):** scanned every runtime file across all 7 cc-market plugins
(fabric/rem/sharp-review/evolve/traceme/watch/cc-latex): `skills/*/SKILL.md`,
`reference/*.md`, `commands/*`, `prompts/*`, `agents/*`.

- **One real violation — evolve:** `skills/evolve/reference/round-protocol.md` deferred to
  `AGENTS.md § Host adaptivity`, while the execution knowledge (step-2 fan-out `Agent` on
  Claude vs `spawn_agent` on Codex; step-1 critique host-agnostic; Codex task guard at round
  start) lived ONLY in dev AGENTS.md — missing at runtime.
- **All other 6 plugins compliant.** Legit references were: host-project `.claude/rules/` /
  project `AGENTS.md` (injected at runtime), rem's maintenance note to update its own
  AGENTS.md, sharp-review meta-commentary.

**Fix (committed 6984f2d):**
- Inlined the host-adaptivity knowledge into `round-protocol.md` (runtime self-contained);
  dev `AGENTS.md` now links OUT to it — clean one-way dev→runtime link.
- Added a **pre-commit lint** in `cc-market/scripts/git-hooks/pre-commit`: fails if a staged
  runtime file matches `(AGENTS|CLAUDE)\.md §` or `→ (AGENTS|CLAUDE)`. Path-filtered to
  runtime dirs only, so host-project references are untouched. Validated: catches fabricated
  violations, zero false positives across the tree, actual commit ran the hook clean.
