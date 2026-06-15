# evolve Invariants

Dev-only constraints on `scripts/evolve.mjs` — not restating the agent-facing flow in
`skills/evolve/SKILL.md` and `reference/*.md` (the runtime source of truth, which must not
drift from these).

## Helper purity
- Pure logic functions (`groupFindings`, `prioritize`, `checkTermination`, `recordRound`,
  `confirmedByQuorum`) must NOT call `Date.now()`/`new Date()` — pass timestamps in (`now`
  param). Keeps tests deterministic and avoids resume-cache breakage if ever wrapped.
- Dependency-free: only `node:fs` / `node:path`. No external packages.

## State ownership
- `saveState` only replaces the `evolveState` key in `.claude/.rem-state.json`; it must
  preserve all other top-level keys (`hook`, `prune`, `reviewGate`, …) shared with rem.
- Never block the loop on a state-write failure — `saveState` returns `{persisted:false}`
  and the loop continues in memory.

## Convergence
- `clean` is severity-based: only NEW open HIGH/MEDIUM findings reset `emptyRounds`. A naive
  "no findings at all" rule never converges (LLM reviewers always surface nits) — do not
  revert to it.
- Findings are quorum-filtered (`confirmedByQuorum`, ≥2 reviewers) before counting toward
  convergence, to drop single-reviewer noise.
