---
name: rem
description: REM sleep for Claude Code and Codex sessions — summarize what changed, update memory, crystallize if needed
---

# REM

## Execution mode (read first)

rem summarizes **this session**, so it needs live context — offload via **`fork`**
(`subagent_type: "fork"`), not a fresh subagent: the fork inherits the conversation (first-hand
summary) yet keeps prep/memory-write noise out of the main session.

**Codex:** run the standard pass inline in the current session unless the host explicitly
offers a context-inheriting fork. A fresh worker without this conversation is not an
equivalent substitute. Do not spawn a second CLI session to reconstruct live context.

1. **Main loop first** runs the user-gated checks (a background fork can't prompt):
   `crystallize.js --check` and `scope-split.js --check` — if either fires, do its interactive
   procedure (`reference/crystallize.md` / `scope-split.md`) inline before forking.
2. **Then dispatch one `fork`** for the standard pass (rem-prep → summarize → write
   memory → index), returning a one-line recap. The fork must not re-fork or
   touch crystallize/scope-split.

Lightweight (doc-only) sessions are cheap — running inline is fine.

When a Stop continuation supplied a session/request acknowledgement command, execute it
only after every required REM step succeeds, in the same project cwd. The command is
`node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-session.js complete --session <id> --request <id>`.
Never acknowledge failed, interrupted, user-blocked or merely scheduled work. Manual REM
without a pending request needs no acknowledgement. A continuation already in progress
does not request another REM pass; review and REM share a transaction-locked reservation.

## Memory Mechanism (global conventions)


Full conventions — the lifecycle (merge / crystallize hide, nothing is deleted), frontmatter schema,
the derived index, scoped memory (monorepo), rules-vs-memory boundary — → `reference/memory-conventions.md`.

### Scripts

Core scripts the happy-path invokes — full table with all scripts and flags → `reference/scripts.md`.

- `rem-prep.js --transcript <path>` — read-only report: entries read, visible / hidden counts, crystallize advisory
- `index-memory.js` — regenerate the derived `.claude/memory-index.md` indexes (written only when the bytes change)
- `remember.js` — immediate save for explicit "remember this" requests (run it right away, don't wait for `/rem`; see `reference/memory-conventions.md` § When memory is written)
- `crystallize.js --check` / `scope-split.js --check` — gated procedures (see below)

### Reference

- Full script reference (incl. `check-docs.js`, `todo.js`, `task.js`, all flags) → `reference/scripts.md`
- `.claude/.rem-state.json` shape (for debugging hook gating) → `reference/state-schema.md`
- Crystallize procedure (current `--check` advisory threshold; user-gated distill) → `reference/crystallize.md`
- Scope-split procedure (large scope; give a cluster its own child scope, nothing moves) → `reference/scope-split.md`
- Standard-pass walkthrough + Lightweight variant → `reference/standard-procedure.md`
- Tasks layer (user-opened tasks, binding, the append-only journal) → `reference/tasks.md`

---

Decide depth by checking context:

## Crystallize (when the advisory check fires)

Check whether crystallize is needed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --check
```
Exit 0 = needed, exit 1 = skip. **If needed**, follow the full user-gated distill procedure in
**`reference/crystallize.md`** (propose → classify → user-confirm → distill into `.claude/rules/rem/`
→ cleanup → check-docs), then continue with the standard REM session below.

## Scope split (large scope + a subdir owns a cluster)

Check whether a memory cluster should get its own child scope:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --check
```
Exit 0 = a split candidate exists, exit 1 = skip. **If a candidate exists**, follow the
user-gated procedure in **`reference/scope-split.md`** (propose → confirm each split →
execute). Self-disables in flat repos with no internal module boundary. Distinct from crystallize:
a split routes NEW entries to a nested scope (existing ones stay) rather than distilling them into rules.

## Lightweight (doc-only or non-code session)

Brief one-sentence summary; usually no memory/rules updates. Run the doc-staleness checks
(`check-docs.js`, `doc-freshness.js`) — full checklist → **`reference/standard-procedure.md`** § Lightweight.

## Standard

Short flow (run in the fork): **0.** `rem-prep.js --transcript "<transcript_path>"`
→ **1.** summarize (what changed, validation, blockers) → **2.** write `.claude/memory/YYYY/MM/DD/`
entries (`--corrects` / `--supersedes` / `merge-memory.js`; never edit an old one), then `index-memory.js` → **3.** update project docs if needed.

Full step-by-step walkthrough →
**`reference/standard-procedure.md`**.

## Cross-project check

If you modified files in OTHER git repos during this session, you MUST also update their `.claude/memory/` and run `index-memory.js` there. Check your transcript — you know which repos you touched.
