---
name: manuscript-rerun
description: Re-run a single step of the manuscript-review pipeline against an existing slug. Replaces the old manuscript-archive / manuscript-repolish skills.
allowed-tools: "Read,Write,Bash,Glob,Grep,Agent,Skill"
---

# /manuscript-review:rerun — Re-run one step

Usage:
```
/manuscript-review:rerun 7 majestic-book        # re-polish (regenerate final.md from draft.md)
/manuscript-review:rerun 8 majestic-book        # re-archive (move + update style + angles)
/manuscript-review:rerun 5 majestic-book        # re-aggregate critiques.md
/manuscript-review:rerun 2 majestic-book        # re-run literature.md (02-literature.md)
/manuscript-review:rerun 2b majestic-book       # rewrite summary.md (02b-consensus.md)
```

Running the CLI: `_shared/running-the-cli.md`. Host differences:
`_shared/host-adapters.md`.

## How it works

1. Read `.claude/skills/manuscript-review/<step>-*.md` for the requested step (e.g. `2` → `02-literature.md`, `2b` → `02b-consensus.md`, `7` → `07-polish.md`). Match the step token exactly — `2` must not pick up `02b-*`.
2. Execute that step's playbook against `ongoing/<slug>/` (or `archived/YYMMDD/<slug>/` if the slug is already archived — glob-match `archived/*/<slug>/` to find it; in that case any new output is written next to the old with a `.<timestamp>` suffix, never overwriting the archive).
3. Steps 7 and 8 are the common cases; steps 1–6 work too but should be rare.

## Convenience aliases

| Old call | Now |
|----------|-----|
| `/manuscript-review:archive <slug>` | `/manuscript-review:rerun 8 <slug>` |
| `/manuscript-review:repolish <slug>` | `/manuscript-review:rerun 7 <slug>` |

## Hard rules

- Reruns against `archived/YYMMDD/<slug>/` never overwrite the existing snapshot; suffix outputs with a timestamp.
- For step 7 specifically: enforce plain-text output (see `07-polish.md`).
- For step 8: dedup + rolling caps still apply.
