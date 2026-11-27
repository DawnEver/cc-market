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
- The loop state is evolve's alone, at `<git dir>/evolve/state.json` (`statePath`, from
  `git rev-parse --git-path`); no other plugin reads or writes it.
- Never block the loop on a state-write failure — `saveState` returns `{persisted:false}`
  and the loop continues in memory.

## Convergence
- `clean` is severity-based: only NEW open HIGH/MEDIUM findings reset `emptyRounds`. A naive
  "no findings at all" rule never converges (LLM reviewers always surface nits) — do not
  revert to it.
- Findings are quorum-filtered (≥2 reviewers) before counting toward convergence — but the
  quorum/dedup is done upstream by sharp-review's merge (a hard dependency), not by re-running
  `confirmedByQuorum` on the merged output (which, lacking per-reviewer fields, would drop
  everything). `confirmedByQuorum` stays as a tested unit helper, not part of the live flow.
