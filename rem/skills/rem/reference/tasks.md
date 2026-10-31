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

An agent never opens a task: `hooks/task-guard.js` (PreToolUse) refuses any agent tool call that
writes a `TASK.md`, rewrites a `JOURNAL.md`, or runs `task.js open|close`. To start a task,
propose it to the user. On Codex (no plugin slash commands) the user runs
`node <rem>/scripts/task.js open …` in their own shell.

## Bind — one task per session

A session or agent works on ONE task, resolved by `resolveTask()` (`scripts/tasks.mjs`):
1. the user's instruction, passed as `--task <slug>`;
2. else the worktree directory name;
3. else the branch's last segment (`pr/<slug>`, `lane/<slug>`, …).

Only an OPEN task binds; nothing else is guessed. `task.js bound` prints the binding.
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

## Close — the user only

`/rem:task close <slug> ["<reason>"]` appends `closed: <reason>` and sets `status: closed`;
a closed task binds no session. An agent proposes closing; the user runs the command.
