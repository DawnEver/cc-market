# REM Scripts Reference

All scripts live at `${CLAUDE_PLUGIN_ROOT}/scripts/`.

| Script | Usage | Key Flags |
|---|---|---|
| `remember.js` | Immediate save for explicit "remember this" requests: write the dated entry and regenerate the index | `--name`, `--type`, `--body` (or stdin), `--scope <dir|auto>`, `--description`, `--update` (append a dated revision to a same-day entry; never drops text) |
| `merge-memory.js` | Fold duplicate entries into ONE live entry: sources appended verbatim under `## Merged from <path>`, listed in its `merged_from:`; source files stay on disk, hidden | `--into <live.md>`, `--from <a.md,b.md>`, `--dry-run` |
| `index-memory.js` | Regenerate every scope's `.claude/rules/MEMORY.md` from its tree; written only when bytes change | `--quiet` |
| `crystallize.js` | Distill entries into `.claude/rules/rem/`; a ledger entry names them (hidden, kept) | `--check`, `--propose`, `--validate`, `--execute --rule <file.md> --distilled <paths>` |
| `scope-split.js` | Relocate a memory cluster into a child scope (a move), user-gated | `--check`, `--propose`, `--execute --scope <subdir> --entries <paths>` |
| `scope-validate.mjs` | Verify every scope: a leftover `_meta.json` warns, entries under `YYYY/MM/DD/`, index current | `--check`, `--fix` (regenerate stale indexes) |
| `rem-prep.js` | Read-only pre-REM report: entries this session read, visible / hidden counts per scope, crystallize advisory | `--transcript <path>` |
| `check-docs.js` | Doc freshness check at crystallize time. Flags a doc only when it *references* a file that changed (by relative path or filename), and names which — not every doc that happens to be untouched | `--json` |
| `task-engine.js` | Task CLI (`/todo`) | `report`, `add`, `remove`, `show`, `mark`, `check`, `help` |
| `task-lib.mjs` | Task pure logic (library, not a CLI) | scan, parseExistingTasks, markFinding, groupBy* |
| `recall.js` | UserPromptSubmit hook: heuristic memory recall → `additionalContext` on both hosts; read-only toward the repo | `--telemetry` (print per-scope latency ring from tmpdir; rows stuck at `done:false` = killed mid-run by the hook timeout) |
| `rem-session.js` | Acknowledge successfully completed REM work for the matching pending Stop request | `complete --session <id> --request <request-id>`; run in the project cwd, never acknowledge unfinished work |
