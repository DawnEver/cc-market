---
created: 2026-10-31
kind: plan
status: approved
---
# PLAN: rem becomes four layers -- rules, docs, memory, tasks

Approved by the user 2026-10-31 ("其他都同意 ... 坚决执行直到完成全部") after two rulings the same day:
"禁止删除!" (no memory is ever deleted) and "我指定才能开任务" (only the user opens a task). Principles: first
principles, discard historical baggage, Occam, single source of truth, layered decoupling, names match behaviour,
no backward compatibility. A first attempt (cc-market 1ac2468) deleted entries and was reverted (e283e5e).

## Why (measured in motronics-studio, 2026-10-31)

- Recall WRITES: `_meta.json` on every prompt, and its lock writes anyway on timeout; it covers 149/2993 entries
  and lives per worktree.
- 1596 entries carry an `accessed:` date rewritten in place; 1499 October entries were edited after creation;
  CORRECTION paragraphs are appended to old entries.
- Every session start rewrites 12 index files; `atomicWriteFile` uses one fixed `<file>.tmp` (fails at 4 x 300 writers).
- 2993 entries (1942 in October), 82 indexed; nothing ever leaves the active set.
- No TASK entity: a long-running agent's state is spread over dated files (the integrator's D1..D121 live in a file
  dated 2026-10-28 that grew until 10-31), and recall injects other tasks' memories into unrelated turns.
- `rem todo` keeps checkboxes inside dated memory dirs (`manual.md`, `sharp-review.md`; 37 files in motronics):
  mutable memory, and a second backlog beside the forge issue tracker, which already files review follow-ups.
- `.claude/rules/MEMORY.md` (and 11 scoped copies) is a GENERATED hot list placed under `rules/`, so it loads every
  turn as if it were a rule, while `rules/` is hard constraints only (DOCS-SPLIT).

## The four layers -- one home per fact

| layer | answers | where | read | mutability | owner |
|---|---|---|---|---|---|
| rules | what must hold | `.claude/rules/` | every turn | revised, user approves | repo |
| docs | how it works NOW | `docs/` (`docs-src/` in motronics) | on demand, by code path | changes with the code | code author |
| memory | why: what happened, was measured, was decided | `.claude/memory/<yyyy>/<mm>/<dd>/<name>` | scoped recall | immutable once written | scope |
| tasks | what is being done, how far | `.claude/tasks/<slug>/` | every turn, by its agent | append-only journal | a user-opened task |

- A memory that describes how something works NOW is docs; distillation moves it there. Docs drift is caught by
  the existing bound-docs mechanism (`rem:refresh-docs`), not a second one.
- A rules page states the constraint and cites the memory entry of its incident; it never retells the incident.

## Tasks

- OPEN: only `/rem:task open <slug> "<goal>"`, a user slash command; `TASK.md` carries `opened_by: user`. A hook
  refuses an agent creating `.claude/tasks/*/TASK.md` (planted control).
- BIND: a session or agent works on one task, named by the user's instruction or its worktree; it appends only to
  that task's `JOURNAL.md`, and the entries it writes carry `task: <slug>`.
- RUN: `TASK.md` = goal, scope, owner, status; `JOURNAL.md` is append-only: dated progress, decisions Dn,
  handoffs, open items.
- CLOSE (the user, or an agent proposes and the user approves): DISTILL first -- mechanism to docs, constraint to a
  proposed rule (user approves), incidents, measurements and reasons to memory entries citing
  `from: tasks/<slug>/JOURNAL.md#Dn` -- then ARCHIVE with
  `git mv .claude/tasks/<slug> .claude/memory/<close-date>/task-<slug>/`. Nothing is deleted.
- An archived task has the SAME architecture as memory: one storage shape `memory/<date>/<name>`, where `<name>` is
  a file (an entry) or a directory (an archived task); one frontmatter (`kind: entry|task`, `scope`, `task`,
  `created`, and `merged_from` / `supersedes` / `corrects` written by the NEWER entry); one recall and index path.

## Todo -- one backlog, no duplicate mechanism

- An open item of a task is a line in that task's JOURNAL (open items), closed by a later line.
- A repo-level backlog item is an ISSUE where the repo has a tracker. The repo says so in a committed
  `.claude/rem.json` `{"backlog": "issues"}`; `rem todo` is then a read-only view over the tasks' open items and
  the tracker, never a second store.
- Without a tracker (generic users), `rem todo` stores one file per item, `.claude/todo/<id>.md` (unique name,
  status in frontmatter); a closed item is archived into memory like a task. No checkboxes inside memory.
- Existing `manual.md` and `sharp-review.md` move (`git mv`) into that form; nothing is deleted.

## Index and recall

- No index file under `rules/`. Indexes are DERIVED (deterministic bytes, written only when they change) or computed
  on demand; the generated `rules/MEMORY.md` files are gitignored artefacts and stop being generated.
- Recall is READ-ONLY and scoped: the bound task's TASK and JOURNAL, entries tagged with that task, live entries of
  the scope(s) of the paths being worked on, and the bound docs of those paths. Other tasks only on explicit query.
- Visibility is DERIVED, never deleted: an entry named in a newer entry's `merged_from` / `supersedes`, and an
  archived task, leave recall and the index; the file stays forever, reachable by provenance.

## Concurrency and merge noise

- The only writable things: your own task's JOURNAL and NEW files with unique names. No shared mutable file.
- Atomic write is unique temp plus rename; derived files need no lock (identical bytes).
- Integration check (dev-lab, consumer side): a merge commit may ADD memory files, never modify or delete one
  (planted control). A memory merge stays inside one `scope` and cites a source file per sentence (test).
- A correction is a new entry with `corrects:`; an old entry is never edited.

## Scale -- by presence, no knobs

- small: `.claude/memory/` only, a derived index, todo files.
- mid: plus scopes (any subdirectory holding `.claude/memory/`).
- large (ours): plus `.claude/tasks/`, bound docs, `rem.json` backlog = issues, and dev-lab's merge checks.
- rem depends only on git and files; family-specific checks (MEMORY-SHAPE, the merge check, the forge) live in dev-lab.

## Phases (TDD each; each reported before the next)

- P0 read never writes: drop `_meta.json`, access counts and the session-start index rewrite; unique-temp atomic
  write. Accept: a 4 writers x 300 concurrency test; a read-only recall test.
- P1 a derived deterministic index outside `rules/`; corrections as `corrects:` entries. Accept: two machines, same bytes.
- P2 the tasks layer: `/rem:task open|close` user-only, bind, append-only journal, agent-open refused (planted control).
- P3 scoped recall (task + scope + bound docs). Accept: an unrelated-task injection test reds on the old recall.
- P4 close = distill + archive (`git mv` into memory), one frontmatter, derived visibility.
- P5 todo: tasks' open items plus the `backlog: issues` view; per-item files otherwise; `manual.md` and
  `sharp-review.md` moved.
- P6 dev-lab: the adds-only merge check, same-scope cited merges, MEMORY-SHAPE reworded (no `accessed`).
- P7 a one-shot migration per repo (strip volatile fields; HANDOFF- / PLAN- / DECISIONS- into tasks or archived
  tasks; todo files moved; NOTHING deleted): a dry run on motronics is shown to the user and applied after approval.
- The first task under the new layer is `integrator`: the D1..D121 journal moves to `.claude/tasks/integrator/JOURNAL.md`.
