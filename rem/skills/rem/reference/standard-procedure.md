# Standard REM Procedure

Full walkthrough of the standard pass (run inside the dispatched fork), plus the lightweight
variant for doc-only sessions.

## Lightweight (doc-only or non-code session)

Brief summary only:
- What was done in one sentence
- Skip `.claude/rules/` and `.claude/memory/` updates unless something surprising came up
- Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js` to detect stale docs — if exit 1, update the flagged files
- Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-freshness.js` to detect drifted knowledge-base docs (frontmatter `doc_source`/`git_hash`) — if exit 1, invoke `/refresh-docs` to update them (no-op for projects with no bound docs)

## Standard

### 0. Run rem-prep (automated mechanical work)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-prep.js --transcript "<transcript_path>" --promote
```

This single command does all of:
- Shows recent prune events (demotions, evictions)
- Scans transcript for `.claude/memory/` file reads → batch-touches `accessed` timestamps and bumps `access_count`
- Auto-promotes short-term entries with `access_count >= 3` to `tier: long`
- Reports crystallize status (warns if ≥20 entries)

Review the output. Re-promote any entries that were demoted but you referenced this session.

### 1. Summarize

1. What changed and why
2. How it was validated (tests run, manual checks, edge cases)
3. Any open blockers or follow-up items

### 2. Update project memory

- `.claude/memory/YYYY/MM/DD/` — add/update content files under date directory
- Run `stamp-memory.js` to auto-index new files:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/stamp-memory.js
  ```

### 3. Update project docs if needed

- If crystallize ran: `check-docs.js` already flagged stale docs above — update them now
- If no crystallize: use judgment — update `AGENTS.md`, `README.md`, etc. if architecture, directory layout, setup steps, or hook behaviour changed this session

### 4. Re-run rem-prep (catch this session's own memory work)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-prep.js --transcript "<transcript_path>" --promote
```

Steps 1-3 above read/edit `.claude/memory/` files (e.g. consolidating entries during crystallize).
Re-running rem-prep here bumps `accessed`/`access_count` for those files too — step 0 only
saw memory files touched *before* `/rem` started, not the ones touched *during* it.
