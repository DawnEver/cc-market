# REM — Crystallize procedure (reference)

Run this when `crystallize.js --check` exits 0 (visible entries reached `CRYSTALLIZE_ADVISORY`), or
whenever a fact has proven it belongs in every session. Distilling memory into always-injected
rules is user-gated — present the proposal before acting.

1. List the visible entries, oldest first:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --propose
   ```

2. Verify the old ones against current reality: grep for the functions, flags and paths an
   entry mentions; check `git log` for the files it references. Then:
   - **Still accurate and needed every session** → rule-worthy (step 3).
   - **Contradicted** → `remember.js --corrects <old>` (part wrong) or `--supersedes <old>` (replaced).
     Never edit or delete the old entry.
   - **Duplicates another entry** → `merge-memory.js --name <slug> --from <a.md,b.md>`.
   - **No longer true and not worth restating** → propose a ledger entry that says so (a dated
     entry whose `supersedes:` names it and whose body says why it is obsolete).

3. Present the classification (rule-worthy / keep / obsolete) to the user with AskUserQuestion
   (multiSelect).

4. After confirmation, distill ONLY the approved entries into `.claude/rules/rem/<topic>.md`,
   grouped by topic, updating rules already there.

5. Record, one call per rule file:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --execute --rule <topic>.md --distilled 2026/05/27/a.md,2026/05/28/b.md
   ```
   It writes `YYYY/MM/DD/crystallized-into-<topic>.md` naming the distilled entries in
   `supersedes:` and pointing at the rule, and regenerates the index. The entries stay on
   disk, hidden from recall and the index; the rule is now the single source.

6. Check documentation freshness:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js
   ```
   If exit 1, update the flagged docs before proceeding.

**Namespace rule:**
- Hand-written rules (one-off, project-specific) → `.claude/rules/<topic>.md`
- Crystallized rules (from memory) → `.claude/rules/rem/<topic>.md`

Then continue with the standard REM session.
