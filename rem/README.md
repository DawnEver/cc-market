# rem

REM sleep for Claude sessions — prune stale memory, consolidate learnings, maintain `.claude/memory/` with timestamps and automatic eviction.

## Install

```shell
/plugin install rem@cc-market
```

Then register the hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/prune-memory.js\" --evict-stale --quiet",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.js\"",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/memo.js\" list --hook",
            "timeout": 5
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/memo.js\" list --hook",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/rem-hook.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

> **On Codex:** install with `codex plugin add rem@cc-market`. The hooks run on Codex too;
> additionally, rem's SessionStart hook injects the host project's `.claude/rules/**/*.md`
> into context (Codex doesn't auto-load them — Claude Code does, where this step is a no-op).
> `/rem` and `/todo` are Claude slash-commands; on Codex invoke the underlying skills directly.
> Prompt-time auto-recall (`recall.js`) is Claude Code only — Codex has no
> `UserPromptSubmit`-equivalent hook, so the script exits silently there.

## Usage

After installation, `/rem` is available as a slash command. It triggers automatically after ≥3 stops and ≥2 min of substantive work, or you can invoke it manually:

```shell
/rem
```

## How It Works

Three-tier memory system (rules / long-term / short-term) and promotion rules → `skills/rem/reference/memory-conventions.md`. Session lifecycle diagram → `AGENTS.md` Architecture section.

Memos (`scripts/memo.js`) sit next to memory: save a file slice or a command's stdout together with the git blob hashes of its sources, and `get` can answer FRESH or STALE (naming what moved) instead of re-reading — the SessionStart/PostCompact `list --hook` surfaces what is still valid right after a compaction dropped the excerpts. Store: `<scope>/.claude/memo/` (gitignored, per-worktree).

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
