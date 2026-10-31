# Standard REM Procedure

Full walkthrough of the standard pass (in an inherited-context fork, or inline on Codex), plus the lightweight
variant for doc-only sessions.

## Lightweight (doc-only or non-code session)

Brief summary only:
- What was done in one sentence
- Skip `.claude/rules/` and `.claude/memory/` updates unless something surprising came up
- Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js` to detect stale docs — if exit 1, update the flagged files
- Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-freshness.js` to detect drifted knowledge-base docs (frontmatter `doc_source`/`git_hash`) — if exit 1, invoke `/refresh-docs` to update them (no-op for projects with no bound docs)

## Standard

### 0. Run rem-prep (read-only report)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-prep.js --transcript "<transcript_path>"
```

It lists the memory entries this session read and, per scope, the live entry count, entries
already named in a live `merged_from` (awaiting retirement), and the crystallize advisory.
It writes nothing.

### 1. Summarize

1. What changed and why
2. How it was validated (tests run, manual checks, edge cases)
3. Any open blockers or follow-up items

### 2. Update project memory — converge, do not pile up

- New learning → a new `.claude/memory/YYYY/MM/DD/<slug>.md` (or `remember.js` when the user
  asked to remember something).
- If it changes what an entry read in step 0 says, the new entry SUPERSEDES it: list the old
  path(s) under `merged_from:`. Never edit an old entry to correct it.
- Duplicates → `merge-memory.js --into <live> --from <dups>`.
- Then delete what is now named:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/retire-memory.js            # dry run
  node ${CLAUDE_PLUGIN_ROOT}/scripts/retire-memory.js --execute
  node ${CLAUDE_PLUGIN_ROOT}/scripts/index-memory.js
  ```

### 3. Update project docs if needed

- If crystallize ran: `check-docs.js` already flagged stale docs above — update them now
- If no crystallize: use judgment — update `AGENTS.md`, `README.md`, etc. if architecture, directory layout, setup steps, or hook behaviour changed this session
