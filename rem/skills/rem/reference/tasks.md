# Tasks — what is being done, and how far

A task is the home of a long-running piece of work: its goal and its running journal. It
replaces state spread over dated memory files. Present only where a repo has
`.claude/tasks/` (scale by presence: small repos never see it).

```
.claude/tasks/<slug>/
  TASK.md      goal, scope, owner, status — written only by the user's /rem:task command
  JOURNAL.md   append-only: dated progress, decisions Dn, open items On, handoffs
```

## Open — the user only

`/rem:task open <slug> "<goal>" [--scope <paths>] [--owner <who>]` — a user slash command
(`commands/task.md`, `disable-model-invocation: true`). It runs `scripts/task.js open` through
command expansion, which is not a tool call. `TASK.md` carries `opened_by: user`.

User authority is a precondition of the library itself: `openTask` / `closeTask` consume a
record that only the user's own prompt creates. `hooks/task-authority.js` (UserPromptSubmit)
records a prompt that IS `/rem:task open|close <slug> …` (verb, slug, prompt hash, session,
time) in `os.tmpdir()/rem-task-authority/`, outside the repo; a record matches exactly one verb
and slug, expires after 30 minutes and is consumed on use. The consumed id is written into
`TASK.md` (`authority:`) and the journal's opened/closed line, and `scope-validate.mjs` reports
a task whose TASK.md lacks it (written around the library). `hooks/task-guard.js` (PreToolUse)
is the second line: it refuses an agent writing a `TASK.md`, rewriting a `JOURNAL.md`, running
`task.js open|close` in any argument order, importing the task library or the authority store,
or pointing an interpreter or shell write at `.claude/tasks/`. To start a task, propose it to
the user. On Codex the user types the same `/rem:task …` prompt (the hook records it) and the
session then runs `task.js open …`.

## Bind — one task per session

A session or agent works on ONE task, resolved by `resolveTask()` (`scripts/tasks.mjs`):
1. the user's instruction, passed as `--task <slug>`;
2. else the worktree directory name;
3. else the branch's last segment (`pr/<slug>`, `lane/<slug>`, …).

Only an OPEN task binds; nothing else is guessed. `task.js bound` prints the binding.

Recall (`scripts/recall.js`) is scoped by the binding, on every prompt:
- the bound task's goal, scope, open items and latest journal lines;
- entries tagged with the bound task rank first; untagged entries of the scope of cwd and of
  the task's `scope:` paths; the bound docs (`doc_source`) covering those paths;
- an entry tagged with ANOTHER task never comes in, unless the prompt names that task.

`remember.js` tags each entry it writes with `task: <slug>` of the bound task.

## Run — the journal is append-only

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js log "merged lane 3; gate green"     # progress
node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js decide "take the newer structure"    # → D<n>
node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js open-item "port the helper"          # → O<n> open
node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js close-item O3 "ported in abc123"     # → O3 closed
node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js handoff "next: rerun the gate"
```

Each call appends ONE line `- <date> <tag>: <text>` (O_APPEND; earlier bytes are never
rewritten) to the bound task's journal only. Decisions and open items number themselves. A
closed task's journal is final. Read with `task.js show [<slug>]` and `task.js list`.

## Close — distill, then archive (the user closes)

1. **Distill** (any session, before the user closes): mechanism → the docs (`/refresh-docs`);
   a constraint → a proposed rule the user approves; incidents, measurements and reasons → memory
   entries that cite their decision, e.g.
   `remember.js --name <slug> --type project --body "…" --from tasks/<slug>/JOURNAL.md#D3`.
   A rule or bound doc that mentions `tasks/<slug>/JOURNAL.md#D3` distills D3 as well.
   `task.js distill-status [<slug>]` lists the undistilled decisions and open items.
2. **Close** — `/rem:task close <slug> ["<reason>"] [--journal-only D<n>,...]` refuses while an item
   is open or a decision is neither distilled nor named in `--journal-only` (kept only in the
   archived journal). It appends `closed: <reason>`, sets `status: closed`, then ARCHIVES:
   `git mv .claude/tasks/<slug> .claude/memory/<close-date>/task-<slug>/` (a plain rename outside
   git). Nothing is deleted. An agent proposes closing; the user runs the command.

## An archived task is memory

One storage shape: `memory/<date>/<name>`, where `<name>` is a file (an entry) or a directory
holding `TASK.md` (an archived task). One frontmatter (`memory-conventions.md`): `TASK.md` already
carries `name`, `description`, `kind: task`, `task`, `created`. One recall and index path: an
archived task is HIDDEN from recall and the index (derived from `kind: task`); its files stay,
reachable by provenance (`from:` citations) and by `task.js show <slug>`. Entries tagged with a
closed task are ordinary memory again: recall excludes only entries of another OPEN task.
