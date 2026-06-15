---
name: evolve-hard-depend-plugins
description: evolve dropped built-in fallbacks; now hard-depends on sharp-review/rem/todo
metadata:
  type: project
---

# evolve: hard-depend on sharp-review/rem/todo (drop built-in fallbacks)

Per user request ("移除兜底，硬依赖插件"), evolve no longer ships built-in equivalents for the
three cc-market plugins it integrates with. Setup now verifies they are installed and aborts if
any is missing.

## What changed
- **State (`evolve.mjs saveState`):** removed the "rem absent → in-memory" branch. It now
  always persists to rem's `.claude/.rem-state.json`, creating it via `shared/state.mjs` if
  absent. The only `persisted:false` path left is a real Windows/OneDrive rename flake.
- **Critique (round-protocol step 1):** removed the hand-rolled 2–3 reviewer fan-out fallback.
  Only `Workflow({name:'sharp-review'})` is used.
- **Quorum gotcha:** sharp-review's merge already emits ≥2-reviewer-confirmed findings (one per
  finding, no `reviewer` field). Re-running `confirmedByQuorum` on that merged output would drop
  everything. So `confirmedByQuorum` is no longer in the live flow — kept only as a tested unit
  helper. Convergence quorum-filtering is now "done upstream by sharp-review".
- **Tasks (step 7):** ids are always `SR-*`; `todo`/`sharp-review.md` are the source of truth,
  mirrored into `evolveState`. Removed the "otherwise update evolveState directly" branch.

## Docs/tests touched
SKILL.md (intro + Setup plugin-check + rem guard), round-protocol.md, termination.md, README.md,
AGENTS.md, invariants.md. Test `saveState no-ops when absent` → `saveState creates the state
file when absent`. 18/18 pass. Committed `31877ea`, pushed (evolve v1.0.2).
