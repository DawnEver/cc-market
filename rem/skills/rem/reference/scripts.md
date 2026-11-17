# REM Scripts Reference

All scripts live at `${CLAUDE_PLUGIN_ROOT}/scripts/`.

| Script | Usage | Key Flags |
|---|---|---|
| `remember.js` | Immediate save for explicit "remember this" requests: write a NEW dated entry (never rewrites one) and regenerate the index | `--name`, `--type`, `--body` (or stdin), `--scope <dir|auto>`, `--description`, `--corrects <paths>`, `--supersedes <paths>`, `--task <slug>` (default: the bound task), `--from <cites>` (e.g. `tasks/<slug>/JOURNAL.md#D3`) |
| `merge-memory.js` | Fold duplicate entries into ONE new entry: sources copied verbatim under `## From <path>`, listed in its `merged_from:`; source files stay byte-identical, hidden | `--name <slug>`, `--from <a.md,b.md>`, `--description`, `--dry-run` |
| `index-memory.js` | Derive every scope's `.claude/memory-index.md` from its tree; written only when bytes change | `--quiet`, `--print` (current scope, write nothing) |
| `crystallize.js` | Distill entries into `.claude/rules/rem/`; a ledger entry names them (hidden, kept) | `--check`, `--decline` (permanent: never asked again), `--propose`, `--validate`, `--execute --rule <file.md> --distilled <paths>` |
| `scope-validate.mjs` | Verify every scope (and that every open task carries its user authority id): a leftover `_meta.json` warns, entries under `YYYY/MM/DD/`, index current | `--check`, `--fix` (regenerate stale indexes) |
| `rem-prep.js` | Read-only pre-REM report: entries this session read, visible / hidden counts per scope, crystallize advisory | `--transcript <path>` |
| `check-docs.js` | Doc freshness check at crystallize time. Flags a doc only when it *references* a file that changed (by relative path or filename), and names which — not every doc that happens to be untouched | `--json` |
| `todo.js` | `/todo`: read-only report of task open items, the backlog and stale docs; `add`/`close` per-item files (refused with `backlog: issues`); `adopt` legacy checkbox files | `report`, `add`, `show`, `close`, `adopt`; `--module`, `--severity`, `--file` |
| `todo-lib.mjs` | Backlog library: `backlogMode`, `addItem`, `closeItem`, `adoptLegacy`, `formatReport` | (library) |
| `recall.js` | UserPromptSubmit hook, both hosts, read-only toward the repo: the bound task (goal, open items, journal tail) plus the top entries and bound docs of the scope(s) being worked on; entries tagged with another task only when the prompt names it. The hook only READS the device-local candidate index and bound-doc cache; a missing or stale one starts a detached `--build` and the prompt answers with what it has | `--build <dir>` (build the index and doc cache of `<dir>`'s repo; what the hook spawns), `--telemetry` (print per-scope latency ring from tmpdir; rows stuck at `done:false` = killed mid-run by the hook timeout) |
| `task.js` | Tasks layer CLI; its verbs are one table, `task-verbs.mjs` | `task.js help` |
| `authority.mjs` | User authority for task open/close: `recordUserCommand` (the UserPromptSubmit hook only), `consumeAuthority` (openTask/closeTask) | (library) |
| `tasks.mjs` | Tasks layer library: `readTask`, `listTasks`, `resolveTask`, `openTask`, `appendJournal`, `distillStatus`, `closeTask`, `findArchivedTask` | (library) |
| `session-binding.mjs` | Where a session's task binding lives (D34): `machineHome`, `bindingFile`, `repoKey`, `writeBinding`, `readBinding`, `retiredBinding`, `migrateRetiredBindings` | (library) |
| `rem-session.js` | Acknowledge successfully completed REM work for the matching pending Stop request | `complete --session <id> --request <request-id>`; run in the project cwd, never acknowledge unfinished work |
