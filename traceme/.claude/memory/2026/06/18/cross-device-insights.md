---
name: cross-device-insights
description: traceme insights Model/Skill/Time sections made cross-device; snapshot now carries skill_usage + active_min; NUL-byte-in-Edit gotcha
metadata:
  type: project
---

# Cross-device insights (Model/Skill/Time)

`insights` Model/Skill/Time were local-only; now aggregated from merged sync
snapshots with a per-day local fallback. `--local` forces this device only.

## What got synced
- `dump.mjs` snapshot payload now carries `skill_usage` (per project x repo_origin x
  skill counts) and `active_min` on session rows. Previously only daily_summary/
  tool_usage/model_facts/sessions were synced.
- `merge.mjs`: `readMergedSnapshot` exposes merged `skill_usage` (new `mergeSkillFacts`)
  alongside already-merged `model_facts`/`sessions`. Both `mergeSkillFacts` and
  `mergeModelFacts` are exported + directly unit-tested.

## Design decisions (don't "fix" these)
- `mergeModelFacts` aggregates by **model only** (collapses project) - matches the local
  `queryModelBreakdown` and how the Model table is displayed. So a per-project Model view
  isn't possible; under `--project` the Model section is **omitted with a note** rather
  than showing unfiltered numbers next to filtered Quick Stats.
- `mergeSkillFacts` keyed by `JSON.stringify([skill, repo_origin, project])` -
  repo_origin is the grouping identity (same as Token/Time), keeps same-basename repos
  distinct. JSON.stringify avoids separator-collision.
- `readMergedSnapshot` **includes** the local device's own pushed snapshot (no skipSelf),
  consistent with the Token section. The per-day merged/local choice is a ternary (mutually
  exclusive), so it does NOT double-count - a recurring false-positive in review.
- Old snapshots predating `skill_usage`/`active_min` contribute 0 until re-pushed
  (`traceme sync push --all`). Intended graceful degradation.

## Gotcha: NUL byte from the Edit/Write tool
A literal NUL (U+0000) slipped into a template-string map key via the Edit tool, making
`merge.mjs` a **binary file** (git `Bin` diff, broken editors, Edit-tool match failures).
Detect by scanning bytes for 0 (`node -e`); `git show --stat` shows `Bin` and a create
with "0 insertions". If a `.mjs`/`.md` suddenly shows as binary, grep for NUL.
