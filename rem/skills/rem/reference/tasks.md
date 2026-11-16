# Tasks — what is being done, and how far

A task is the home of a long-running piece of work: its goal and its running journal. It
replaces state spread over dated memory files. Present only where a repo has
`.claude/tasks/` (scale by presence: small repos never see it).

```
.claude/tasks/<slug>/
  TASK.md      goal, scope, owner, status — written only by the user's /rem:task command
  JOURNAL.md   append-only: dated progress, decisions Dn, open items On, handoffs
```

## Open — refused by default, detectable when bypassed

`/rem:task open <slug> "<goal>" [--scope <paths>] [--owner <who>]` — a user slash command
(`commands/task.md`, `disable-model-invocation: true`). It runs `scripts/task.js open` through
command expansion, which is not a tool call. `TASK.md` carries `opened_by: user`.

An authority record is a precondition of the library itself: `openTask` / `closeTask` consume a
grant that the user's own prompt creates. `hooks/task-authority.js` (UserPromptSubmit) appends a
`granted` event for a prompt that IS `/rem:task open|close <slug> …` (verb, slug, prompt hash,
session, time) to `~/.claude/rem/authority/<project>.jsonl` (directory 0o700, owner checked on
POSIX; never a shared temp dir). A grant matches exactly one verb and slug, is live for 30
minutes, and is spent by a `consumed` event; the history is append-only. The consumed id is
written into `TASK.md` (`authority:`) and the journal's opened/closed line.

An agent may open a task itself, but only under the user's authorization (user ruling
2026-11-15): `task.js request <slug> "<goal>"` records a `requested` event with a six-hex code
and prints it. The user's prompt that IS `approve <code>` (or `批准 <code>`, `同意 <code>`,
optionally after `/rem:task`) makes the same hook append a `granted` event for that request's verb
and slug; the agent then runs `task.js open`, which consumes it as above. A request grants
nothing by itself, a prompt that merely mentions the code is not an approval, and a code is
approved once and only while its request is live (30 minutes).

Detection: `scope-validate.mjs` errors when a task's id is missing, or when this machine's history
for the project exists and lacks the id or shows it consumed by another task; with no local history
(another workstation, CI, a wiped `~/.claude`) it warns that it cannot check here; `git log -- .claude/tasks/<slug>/TASK.md` shows who wrote it.

Limit: the hook and an agent's shell run as the same OS user, so a determined agent can
forge a record; preventing that would need a privilege boundary. `hooks/task-guard.js` (PreToolUse)
is the second line: it refuses an agent writing a `TASK.md`, rewriting a `JOURNAL.md`, running
`task.js open|close` in any argument order, importing the task library or the authority store,
or pointing an interpreter or a writer's TARGET path at `.claude/tasks/` (judged by what a command
does: the task.js verb in argv position, the target of >, tee, cp/mv, sed -i …; message and
body arguments and read-only commands never match). To start a task, propose it to
the user. On Codex the user types the same `/rem:task …` prompt (the hook records it) and the
session then runs `task.js open …`.

**The one live check** (the hook's prompt shape): probe mode logs every RAW prompt verbatim, so
use it for this check only and unset it after. Start a session with
`REM_AUTHORITY_PROBE=1`, type `/rem:task open probe`, read
`~/.claude/rem/authority/probe.jsonl`, and pin the observed prompt in
`tests/task-authority.test.mjs`. If the prompt arrives in another shape than
`/rem:task open probe`, `parseTaskCommand()` must accept it.

## Bind — one task per session

A session or agent works on ONE task, resolved by `resolveTask()` (`scripts/tasks.mjs`):
1. the user's instruction, passed as `--task <slug>`;
2. else the session's binding: the user's prompt whose FIRST line is `task: <slug>` binds the
   session (user decision D5, 2026-11-15). dev-lab records it (`dev_lab.dev.taskbinding`, in the
   per-machine consent state no agent tool writes); rem only READS it, through the main
   checkout's `.venv` python `-m dev_lab.dev.taskbinding status` (`task <slug>@<authority>`).

The binding counts only while `.claude/tasks/<slug>/TASK.md` under the MAIN checkout is `status:
open` with the same `authority:`; a closed task, or a reopened one under another authority,
binds nothing. No python, no dev-lab, or no binding means no task -- nothing is guessed: a
worktree or branch named after a task binds nothing. A bound session resolves its task from any
worktree and branch. `task.js status` prints the bound task, or `no task bound:` and the door.

When the main checkout lacks the task (it sits on a branch without it) while this checkout holds
it OPEN, `task.js place <slug>` copies TASK.md and JOURNAL.md there verbatim (cc-market #18). It
opens nothing: the task must be open here with an authority the local history does not contradict.
It writes only where the main checkout has no copy; a differing copy is refused, never overwritten.
Any session may run it; the task guard refuses only `open` and `close`.

Branches derive from the task: a session bound to `<slug>` names its branches
`pr/<slug>/<feature>`, never a bare `pr/<slug>`.

Recall (`scripts/recall.js`) is scoped by the binding, on every prompt:
- the bound task as ONE line of at most 200 bytes (`task <slug>: N open, M decisions, last D<n>
  (MM-DD) "..."; detail: task.js status`), only when it changed since the session last saw it
  (and again after a compaction); `task.js status` (at most 2 KB) and `task.js show` go deeper;
- entries tagged with the bound task rank first; then the untagged entries of the root's memory, and
  the bound docs (`doc_source`) covering the task's `scope:` paths (every bound doc when it has none);
- an entry tagged with ANOTHER task never comes in, unless the prompt names that task.

`remember.js` tags each entry it writes with `task: <slug>` of the bound task.

## Run — the journal is append-only

The verbs are one table, `scripts/task-verbs.mjs`: `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.js help`.

An `append` verb adds ONE line `- <date> <tag>: <text>` (O_APPEND; earlier bytes are never
rewritten) to the bound task's journal only. Decisions and open items number themselves, max+1,
under a lock, so two sessions never mint one ID twice. A closed task's journal is final. Lines are
English by default (`memory-conventions.md` § Language).

A `rewrite` verb (translate, amend) replaces one line in place, keeping its `- <date> <tag>: `
prefix byte-identical, and appends an audit line; so the journal is append-only except for those
two audited rewrites. Every other rewrite stays refused (the library and the PreToolUse guard).

## Close — distill, then archive (the user closes)

1. **Distill** (any session, before the user closes): mechanism → the docs (`/refresh-docs`);
   a constraint → a proposed rule the user approves; incidents, measurements and reasons → memory
   entries that cite their decision, e.g.
   `remember.js --name <slug> --type project --body "…" --from tasks/<slug>/JOURNAL.md#D3`.
   A rule or bound doc that mentions `tasks/<slug>/JOURNAL.md#D3` distills D3 as well.
   `task.js status [<slug>] --distill` lists the undistilled decisions and the open items.
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
