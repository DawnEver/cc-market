# REM — Crystallize procedure (reference)

Run this only when `crystallize.js --check` exits 0 (memory index ≥ 20 entries). The everyday
`/rem` flow never touches it. Distilling memory into always-injected rules is a user-gated
operation — present the proposal before acting.

**If crystallize needed, present the proposal to the user before acting:**

1. Run the propose command to get structured data:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --propose
```
This outputs JSON with every indexed entry, including its tier, access_count, and description.

2. Classify each entry as rule-worthy or keep-as-memory:
   - **Rule-worthy** (should be always-injected): durable insights, behavioral constraints, invariants, gotchas that apply every session. Typically entries with `tier: long` and `access_count >= 5`.
   - **Keep-as-memory** (on-demand): historical reference, one-off decisions, bug-specific notes, context useful but not needed every session.

3. Present the classification to the user with AskUserQuestion (multiSelect) — let them deselect items they want kept as long-term memory.

4. After user confirmation, read ONLY the approved-to-be-rules entries and distill them into `.claude/rules/rem/` rule files, organized by topic:
   - `.claude/rules/rem/hook.md` — hook behavior and guards
   - `.claude/rules/rem/api-proxy.md` — proxy gotchas and invariants
   - `.claude/rules/rem/takeover.md` — plugin architecture
   - etc. Group related memory topics under the same rule file.
   - **Do NOT distill entries the user chose to keep as long-term memory.**
   - Update any outdated rules already in `.claude/rules/rem/`.

5. Run the cleanup script with ONLY the distilled paths:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --execute --distilled 2026/05/27/feedback_git_commit.md,2026/05/28/retrospect_hook_task_guard.md
```
This removes only the distilled entries from the index — un-distilled entries stay. Without `--distilled`, clears all entries (full reset).

6. Check documentation freshness:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js
```
If exit 1, uncommitted changes were found and doc files are stale — update the flagged docs before proceeding.

**Manual verification:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --validate
```

**Namespace rule (enforced by crystallize.js):**
- Hand-written rules (one-off, project-specific) → `.claude/rules/<topic>.md`
- Crystallized rules (from memory consolidation) → `.claude/rules/rem/<topic>.md`
- `.claude/memory/` is append-only — crystallize.js verifies no files were deleted

Then continue with the standard REM session.
