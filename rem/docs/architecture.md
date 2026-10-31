# REM Plugin — Dev Reference

Progressive-disclosure reference for the REM plugin. This is the deep detail behind
`AGENTS.md` (the entry point); load the relevant section here when a task reaches into
that area.

## Architecture

```
UserPromptSubmit → task-authority.js (records the user's own /rem:task open|close prompt)
PreToolUse → task-guard.js (refuses an agent opening/closing a task or rewriting its files)
SessionStart → inject-rules.js (Codex-only: feed host .claude/rules into context)
            → memo.js list --hook (saved facts with FRESH/STALE vs their sources' blob hashes)
PostCompact → memo.js list --hook (Claude; Codex restores via SessionStart source=compact)
     ↓
 [Claude reads/writes .claude/memory/ files]
     ↓
  UserPromptSubmit → recall.js (both hosts; read-only; SCOPED: the bound task's goal/open items/journal tail,
                     then entries + bound docs of the scope(s) worked on; another task's entries only when named)
     ↓
  Stop → rem-hook.js (session-scoped locked gate; explicit successful-work acknowledgement)
     ↓
  /rem skill:
    ├── main loop: run user-gated crystallize/scope-split checks first (a fork can't prompt)
    ├── then use a context-inheriting fork or Codex inline pass (first-hand session summary,
    │   keeps prep/memory-write noise out of the main session) → returns a one-line recap
    ├── rem-prep.js — read-only: entries read this session, visible / hidden counts, advisory
    ├── Model summarizes learnings → writes NEW memory files (corrects / supersedes / merge-memory.js; never edits one)
    ├── index-memory.js (derived .claude/memory-index.md, written only on change)
    ├── If visible entries ≥ CRYSTALLIZE_ADVISORY → crystallize into .claude/rules/rem/ (ledger hides the sources)
    │   └── check-docs.js — audit doc freshness after crystallization
    ├── If scope large + a subdir owns a cluster → scope-split into a child scope (user-gated)

  /rem:task command (the user's; an agent is refused by default, a bypass is detected):
    ├── open <slug> "<goal>"  → task.js open  → .claude/tasks/<slug>/{TASK,JOURNAL}.md
    └── close <slug>          → task.js close: refuse until distilled, then git mv into
                                .claude/memory/<date>/task-<slug>/ (hidden, kept)
  task.js log|decide|open-item|close-item|handoff → append to the bound task's JOURNAL.md

  /todo skill (the one backlog):
    ├── /todo        → todo.js report  (read-only: task open items, backlog, stale docs)
    ├── /todo add    → todo.js add      (.claude/todo/<id>.md; refused with rem.json backlog: issues)
    ├── /todo close  → todo.js close    (write .claude/memory/<date>/todo-<id>.md whole, then git rm the item)
    └── /todo adopt  → todo.js adopt    (legacy manual.md / sharp-review.md → item files)
```

Memory lifecycle (rules + dated entries; merge / crystallize hide, nothing is deleted) → `skills/rem/reference/memory-conventions.md`.

## Living docs

**Living docs** are a *separate collection* from dated event memory: mutable, code-anchored,
refreshed in place, never hidden. Kept out of the memory tree, so memory provenance never touches
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
├── hooks/          hooks.json + rem-hook.js + task-guard.js
├── commands/       task.md (/rem:task, the user's command)
├── scripts/        lib.mjs, index-memory.js, remember.js, merge-memory.js, crystallize.js, task.js, tasks.mjs, scope-split.js,
│                   rem-prep.js, check-docs.js, doc-freshness.js, inject-rules.js, recall.js, memo.js, todo.js, todo-lib.mjs, scope-validate.mjs
├── skills/         rem/SKILL.md + todo/SKILL.md + investigate/SKILL.md + refresh-docs/SKILL.md
├── migrations/     migrate.mjs (one-shot move to the tree-only lifecycle; --dry-run)
├── tests/          *.test.mjs (see AGENTS.md § Testing)
├── docs/           architecture.md (this file — the dev reference behind AGENTS.md)
├── .claude/rules/  invariants only
├── CLAUDE.md
└── AGENTS.md       entry point → links here for deep detail
```
