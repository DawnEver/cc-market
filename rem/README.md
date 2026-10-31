# rem

REM sleep for Claude Code and Codex sessions — consolidate learnings into `.claude/memory/`, where no entry is ever deleted or edited: a newer entry corrects, supersedes or merges older ones, and the index is derived from the files.

The derived index (`.claude/memory-index.md`, outside `rules/`) is read on demand; recall injects
the visible entries and bound docs of the scope being worked on, plus the bound task — never another task's memory unless the prompt names it. Reading memory never writes.

**Tasks** (`.claude/tasks/<slug>/`): opening or closing one without the user's `/rem:task open|close` prompt is refused by default and detectable when bypassed (an agent running as the same OS user could still forge it); a session binds to one task (`--task`, or its worktree/branch name) and appends to its append-only `JOURNAL.md` with `task.js log|decide|open-item|close-item|handoff`. Closing distills the decisions into docs, rules and memory entries first, then archives the task by `git mv` into `.claude/memory/<date>/task-<slug>/`. → `skills/rem/reference/tasks.md`.

**Todo** — one backlog: a task's open items are journal lines; a repo backlog item is an issue where `.claude/rem.json` says `{"backlog": "issues"}` (then `/todo` is a read-only view), else one file per item in `.claude/todo/`, archived into memory when closed. No checkboxes in memory. → `skills/todo/SKILL.md`.

## Install

```shell
/plugin install rem@cc-market
```

Installation supplies the plugin-owned hooks in `hooks/hooks.json`: startup memory
maintenance, rules and memo restoration, prompt-time recall, and the Stop gate.
Do not copy these handlers into user settings: native hook sources accumulate,
and duplicate registrations can run the same lifecycle work twice.

> **On Codex:** install with `codex plugin add rem@cc-market`. The hooks run on Codex too;
> additionally, rem's SessionStart hook injects the host project's `.claude/rules/**/*.md`
> into context (Codex doesn't auto-load them — Claude Code does, where this step is a no-op).
> `/rem` and `/todo` are Claude slash-commands; on Codex invoke the underlying skills directly.
> Prompt-time recall runs on both hosts and touches only memories actually injected.
> Codex `SessionStart source=compact` restores rules and memo context immediately after
> compaction. Resume/fork inherit rules rather than guessing from transcript file size.
> Normal hook trust review is required; configuration presence is not proof of execution.
> Stop requests the REM skill using native continuation on Codex, with bounded recursion,
> session-isolated state and explicit successful-work acknowledgement. Run inline when a
> context-inheriting fork is unavailable; an empty worker is not equivalent.
> Codex gates use the actual execution thread, not a shared parent `session_id`.
> When no execution identity is available, the hook does not request continuation.
> A live REM or review reservation excludes other continuations in the same checkout;
> per-thread counters remain independent and deferred work waits for an eligible Stop.

## Usage

After installation, `/rem` is available as a slash command. It triggers automatically after ≥3 stops and ≥2 min of substantive work, or you can invoke it manually:

```shell
/rem
```

## How It Works

Memory lifecycle → `skills/rem/reference/memory-conventions.md`. Session lifecycle diagram → `AGENTS.md` Architecture section.

Memos (`scripts/memo.js`) sit next to memory: save a file slice or a command's stdout together with the git blob hashes of its sources, and `get` can answer FRESH or STALE (naming what moved) instead of re-reading. Claude uses SessionStart/PostCompact; Codex uses structured SessionStart output including `source=compact` and returns empty JSON for PostCompact. Store: `<scope>/.claude/memo/` (gitignored, per-worktree).

## Skills

| Skill | Purpose |
|---|---|
| `/rem` | REM sleep — summarize, update memory, crystallize if needed |
| `/todo` | Task management — view, add, sync, and resolve findings |

## Scripts & Files

Full script flag reference → `skills/rem/reference/scripts.md`. File structure and test layout → `AGENTS.md`.

## Tests

```shell
node --test cc-market/rem/tests/*.test.mjs
```

A pre-commit hook in the cc-market repo runs the tests for any plugin whose files are staged.
