# REM Plugin — AGENTS.md

Memory management plugin for Claude Code sessions. Rules (always injected) and dated memory entries (derived index + prompt-time recall) that converge: a successor names what it replaces in `merged_from:` and the replaced entry is deleted.

## Architecture — at a glance

SessionStart runs the index / inject / memo-listing hooks (Codex compact restores context);
PostCompact re-lists memos on Claude Code; UserPromptSubmit runs recall on both hosts; Stop fires
`rem-hook.js`, gated after ≥3 stops AND (≥2 min session OR ≥30s + substantive edits), which
requests the REM skill. The skill runs user-gated checks first, then uses a context-inheriting
fork on Claude or the current session on Codex. `/todo` drives `task-engine.js`. Full
lifecycle flow diagram → `docs/architecture.md` § Architecture.

Memory lifecycle → `skills/rem/reference/memory-conventions.md`. Nothing writes on read; the index is derived.

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module, `hooks/`, `scripts/`, `skills/`, `tests/`, `docs/`) →
  `docs/architecture.md` § File Structure.
- **Architecture lifecycle** (full SessionStart→PostCompact→UserPromptSubmit→Stop flow and the
  `/rem` / `/todo` dispatch trees) → `docs/architecture.md` § Architecture.
- **Living docs** (separate collection from dated memory, `doc_source` binding, git-drift
  freshness, `/refresh-docs`) → `docs/architecture.md` § Living docs.
- **Memos** (`scripts/memo.js` fact caching, STALE detection via source blob hashes, `--cmd`
  without `--from` REFUSED) → `docs/architecture.md` § Memos.

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for append-only, path security, frontmatter, index, and state constraints.

## Host Behavior

Claude Code requests `/rem`; Codex uses native Stop continuation to request the skill.
Runtime execution-thread facts live in `hook.sessions[executionKey]`, updated inside the existing
state transaction lock. Completion is explicitly acknowledged rather than inferred
from another Stop. Native lifecycle source fields replace transcript-size guesses.
Shared host facts normalize structured transcript records without guessing shell I/O.
The bundled identity helper never treats Codex parent lineage as an execution key.
A live continuation reservation excludes other REM/review dispatches checkout-wide;
deferred sessions retain their counters and resume eligibility after completion or expiry.
Execution and acknowledgement procedures live in the REM skill and its references.

## Reference

Script flag reference, the `.claude/.rem-state.json` schema, and the (rare, user-gated) crystallize
procedure now live in `skills/rem/reference/` (`scripts.md`, `state-schema.md`, `crystallize.md`) —
loaded on demand by `/rem`.

## Testing

```shell
node --test cc-market/rem/tests/*.test.mjs
```

Pre-commit hook runs rem tests when rem files are staged. Functions exported for testing: `decideStop`, `isFreshSession`, `hasSubstantiveWork`, `readTranscriptTail` from `rem-hook.js`; `findProjectRoot` and all other `lib.mjs` exports are public.

Test files: `rem/tests/*.test.mjs` (the lifecycle contract is `lifecycle.test.mjs`).

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for paths, constants, entries, the derived index format, and retirement.
- **When memory entries are created or split**: update MEMORY.md, AGENTS.md, and README.md to reflect the new structure.
