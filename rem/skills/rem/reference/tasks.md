# Tasks — what is being done, and how far

A task is the home of a long-running piece of work: its goal and its running journal. It
replaces state spread over dated memory files. Present only where a repo has
`.claude/tasks/` (scale by presence: small repos never see it).

```
<main checkout>/.claude/tasks/            the LEDGER: one per repository
  <slug>/TASK.md      goal, scope, owner, status — written only by the user's /rem:task command
  <slug>/JOURNAL.md   append-only: dated progress, decisions Dn, open items On, handoffs
<machine home>/state/sessions/<session>.json   the session's binding — written only by rem's
                                               UserPromptSubmit hook (§ Bind); one per session, every repo
```

**The ledger is REPO state, not branch state** (cc-market #20, 2026-11-16). Every read and write
resolves through ONE resolver, `tasksDir()` (`scripts/tasks.mjs`): the parent of
`git rev-parse --git-common-dir`, i.e. the main
checkout's `.claude/tasks/`, the same directory from every worktree. A task opened in one worktree
is found, bound, journaled and admitted from every other. The ledger is never committed on a
feature branch; `close` archives a task into the closing tree's memory, which is committed.

## Open — refused by default, detectable when bypassed

`/rem:task open <slug> "<goal>" [--scope <paths>] [--owner <who>]` — a user slash command
(`claude-commands/task.md`, `disable-model-invocation: true`). It runs `scripts/task.js open` through
command expansion, which is not a tool call. `TASK.md` carries `opened_by: user`.

An authority record is a precondition of the library itself: `openTask` / `closeTask` consume a
grant that the user's own prompt creates. `hooks/task-authority.js` (the task half of rem's one UserPromptSubmit hook `hooks/user-prompt.js`, the one task
hook: it also binds, § Bind) appends a
`granted` event for a prompt that IS `/rem:task open|close <slug> …` (verb, slug, prompt hash,
session, time) to `~/.claude/rem/authority/<project>.jsonl` (directory 0o700, owner checked on
POSIX; never a shared temp dir). A grant matches exactly one verb and slug, is live for 30
minutes, and is spent by a `consumed` event; the history is append-only. The consumed id is
written into `TASK.md` (`authority:`) and the journal's opened/closed line.

An agent may open a task itself, but only under the user's authorization (user ruling
2026-11-15): `task.js request <slug> "<goal>"` records a `requested` event with a six-hex code
and prints it. The user's prompt that IS `approve <code>` (or its Chinese forms `\u6279\u51c6 <code>`, `\u540c\u610f <code>`,
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
   session (user decision D5, 2026-11-15). rem's ONE task hook, `hooks/task-authority.js` (run by `hooks/user-prompt.js`)
   (UserPromptSubmit), writes it (`bindSession`) and tells the session its task and PR heads, or
   why nothing was bound (no open task: the door is `/rem:task open`). rem READS the one file
   directly (`readSessionBinding`). Node only: no process is spawned and no project venv takes
   part, so a broken interpreter cannot stop a binding. The task guard refuses an agent's write to it.

**The binding file -- the contract other tools read.** rem owns it and is its only writer; a
git-side gate (another tool's pre-push hook) reads it and never writes it:

- the ledger: `<parent of git rev-parse --path-format=absolute --git-common-dir>/.claude/tasks/`;
- the binding is SESSION state, not repo state (user ruling D34, 2026-11-17):
  `<machine home>/state/sessions/<session>.json` =
  `{"session": "<id>", "task": "<slug>@<authority>", "ledger": {"repo_key": "<name>-<digest>", "path": "<ledger>"}}`,
  exactly those keys (`scripts/session-binding.mjs`). The machine home is lab_commons'; rem reads it from ONE
  variable, `LAB_COMMONS_HOME`, which dev-lab writes into the user Claude settings
  (`python -m dev_lab.dev.remhome --install`). Unset, rem binds nothing and names that command; `repo_key` is lab_commons.repostate's (`<checkout name>-<first 12
  hex of SHA-256 of the resolved git common dir, case-folded where the filesystem ignores case>`). Every repo's
  check reads the one file, so a session bound in repo A pushes from repo B; the task is judged in the ledger
  the record names. `<id>` is the harness's session as a process inside it sees it --
  `CLAUDE_CODE_SESSION_ID` on Claude Code, `CODEX_THREAD_ID` on Codex (the executing thread, never
  a parent's id);
- valid only while `<ledger>/<slug>/TASK.md` has frontmatter `status: open` and the same
  `authority: <authority>`; anything else binds nothing. rem's own journal verbs act only in that ledger's repo.
- the retired per-repo store `<ledger>/.bindings/<session>.json` is never read: `migrations/migrate.mjs
  <main checkout>` moves its records ONCE (a second run is a no-op), and a record still there is refused by
  name with that migration.

Pinned by `tests/task-bind.test.mjs` and `tests/session-binding.test.mjs`, whose fixture
`tests/fixtures/session-binding.json` dev-lab asserts byte-identically. Changing a key or a path is a contract
change: readers move with it.

The binding counts only while the ledger's `<slug>/TASK.md` is `status: open` with the same
`authority:`; a closed task, or a reopened one under another authority, binds nothing. No binding
means no task -- nothing is guessed: a worktree or branch named after a task binds nothing. A
bound session resolves its task from any worktree and branch. `task.js status` prints the bound
task, or `no task bound:` and the door.

A worktree that still holds an OPEN task in its own tree (written before the ledger was repo
state, or committed on a branch) moves it into the ledger with `task.js place <slug>`: it copies
TASK.md and JOURNAL.md verbatim (cc-market #18). It opens nothing: the task must be open there with
an authority the local history does not contradict. It writes only where the ledger has no copy;
a differing copy is refused, never overwritten -- the user decides which record stands. Any
session may run it; the task guard refuses only `open` and `close`. `task.js commit-record` is
retired (`RETIRED_VERBS` in `scripts/task.js`): nothing commits the ledger on a branch.

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
3. **onClose** — a repo may declare what a close also does: `.claude/rem.json`
   `{"onClose": ["<prog>", "<arg>", "{slug}"]}`, an argv (no shell) whose `{slug}` is the closed task, run
   from the project root after every refusal above has passed and before the archive. It never blocks
   the close: its exit and output (stdout then stderr, one line) go on the closed line as
   `(on close, exit <n>: ...)` and are printed. Undeclared, nothing extra runs; a declaration that is not
   an argv array refuses the close before any write. rem names no consumer — a family, for example,
   declares a command that prunes the task's `pr/<slug>/*` branches and names each one it keeps.

## An archived task is memory

One storage shape: `memory/<date>/<name>`, where `<name>` is a file (an entry) or a directory
holding `TASK.md` (an archived task). One frontmatter (`memory-conventions.md`): `TASK.md` already
carries `name`, `description`, `kind: task`, `task`, `created`. One recall and index path: an
archived task is HIDDEN from recall and the index (derived from `kind: task`); its files stay,
reachable by provenance (`from:` citations) and by `task.js show <slug>`. Entries tagged with a
closed task are ordinary memory again: recall excludes only entries of another OPEN task.
