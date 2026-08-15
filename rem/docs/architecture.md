# REM Plugin — Dev Reference

Progressive-disclosure reference for the REM plugin. This is the deep detail behind
`AGENTS.md` (the entry point); load the relevant section here when a task reaches into
that area.

## Architecture

```
SessionStart → prune-memory.js --evict-stale
            → inject-rules.js (Codex-only: feed host .claude/rules into context)
            → memo.js list --hook (saved facts with FRESH/STALE vs their sources' blob hashes)
PostCompact → memo.js list --hook (same listing at the moment context is actually lost)
     ↓
 [Claude reads/writes .claude/memory/ files]
     ↓
  UserPromptSubmit → recall.js (Claude Code only: heuristic memory recall → additionalContext; silent on Codex)
     ↓
  Stop → rem-hook.js (gates after ≥3 stops AND (≥2 min session OR ≥30s + substantive code edits))
     ↓
  /rem skill:
    ├── main loop: run user-gated crystallize/scope-split checks first (a fork can't prompt)
    ├── then dispatch a `fork` for the standard pass (inherits session context → first-hand summary,
    │   keeps prune/prep/stamp/memory-write noise out of the main session) → returns a one-line recap
    ├── rem-prep.js — scan transcript, bump accessed, suggest promotions
    ├── Model summarizes learnings → writes memory files
    ├── Update MEMORY.md index
    ├── If ≥20 entries → crystallize into .claude/rules/rem/
    │   └── check-docs.js — audit doc freshness after crystallization
    ├── If scope large + a subdir owns a cluster → scope-split into a child scope (user-gated)

  /todo skill (user-facing task management):
    ├── /todo        → task-engine.js report  (scans memory directly)
    ├── /todo add    → task-engine.js add --summary "..."
    ├── /todo remove → task-engine.js remove <id>  (or close SR-*)
    ├── /todo mark   → task-engine.js mark <id> <open|fixed|closed>
    └── /todo check  → task-engine.js report  (report includes stats)
```

Three-tier memory system (rules / long-term / short-term) → `skills/rem/reference/memory-conventions.md`.

## Living docs

**Living docs** are a *separate collection* from dated event memory: mutable, code-anchored,
refreshed in place, never evicted. Kept out of the memory tree, so prune/eviction never touches
them — the opposed-lifecycle conflict is solved by separation, not a special case. The tracked
doc frontmatter carries only the semantic binding (`doc_source` + optional thresholds);
discovery is by that signature via `git ls-files` (honoring `.gitignore`). All volatile state is
device-local in `.claude/.rem-state.json` `docs` (roots cache + per-doc `anchors` git_hash/reviewed_at) —
no location config, user disambiguates multiple roots. `doc-freshness.js` detects git drift
(commits / churn / age); `/refresh-docs` incrementally rewrites and re-anchors via `--set-anchor`.
Stale docs surface in `/todo` as virtual `DOC-` rows. See `skills/refresh-docs/SKILL.md`.

## Memos

Memos (`scripts/memo.js`) cache an expensive fact — a file slice or a command's stdout — together with
the git blob hashes of the sources it depends on, so re-reading it costs one call and can say STALE
(naming the source that moved) instead of silently serving a drifted note. Store: `<scope>/.claude/memo/`
(gitignored by migrate; per-worktree by construction). CLI: `save <name> (--file f [--lines a,b] |
--cmd "..." --from paths...)` / `get <name> [--refresh]` / `list`. A `--cmd` memo without `--from` is
REFUSED — a memo with guessed sources would report FRESH on a stale value. SessionStart and PostCompact
run `list --hook` (never exits non-zero); PostCompact is the moment a compaction has dropped the
excerpts the saved facts were paid for.

## File Structure

```
rem/
├── hooks/          hooks.json + rem-hook.js
├── scripts/        lib.mjs, stamp-memory.js, remember.js, prune-memory.js, touch-memory.js, crystallize.js, scope-split.js,
│                   rem-prep.js, check-docs.js, doc-freshness.js, inject-rules.js, recall.js, memo.js, task-engine.js, task-lib.mjs, scope-validate.mjs
├── skills/         rem/SKILL.md + todo/SKILL.md + investigate/SKILL.md + refresh-docs/SKILL.md
├── tests/          *.test.mjs (see AGENTS.md § Testing)
├── docs/           architecture.md (this file — the dev reference behind AGENTS.md)
├── .claude/rules/  invariants only
├── CLAUDE.md
└── AGENTS.md       entry point → links here for deep detail
```
