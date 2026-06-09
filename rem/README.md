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
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/prune-memory.js\" --evict-stale",
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

## Usage

After installation, `/rem` is available as a slash command. It triggers automatically after ≥3 stops and ≥2 min of substantive work, or you can invoke it manually:

```shell
/rem
```

## How It Works

### Three-tier memory system

| Tier | Location | Loaded | Eviction |
|---|---|---|---|
| Rules | `.claude/rules/` | Every session | Never |
| Long-term | `.claude/memory/` (tier: long) | On demand via index | Demoted if inactive between prune cycles |
| Short-term | `.claude/memory/` (tier: short) | On demand via index | 90-day eviction |

### Session lifecycle

```
SessionStart → prune-memory.js --evict-stale (remove stale, demote inactive long-term)
       ↓
   [Claude works, reads/writes memory files, references sharp-review findings]
       ↓
    Stop → rem-hook.js (after 3+ stops, ≥2 min)
       ↓
    /rem skill triggers:
      ├── rem-prep.js — scan transcript (memory files + SR-IDs), bump accessed, suggest promotions
      ├── Summarize learnings → write .claude/memory/YYYY/MM/DD/<topic>.md
      ├── Update MEMORY.md index
      ├── If ≥20 entries → compact.js distills into .claude/rules/rem/
      │   └── check-docs.js — audit doc freshness
```

### Promotion

Memories referenced frequently (≥3 git commits) auto-promote from short-term to long-term. Manual promotion:

```shell
node scripts/touch-memory.js 2026/06/03/some-entry.md --promote
```

## Skills

| Skill | Purpose |
|---|---|
| `/rem` | REM sleep — summarize, update memory, compact if needed |
| `/todo` | Task management — view, add, sync, and resolve findings |

## Scripts

| Script | Purpose |
|---|---|
| `stamp-memory.js` | Initialize memory system (idempotent) |
| `prune-memory.js` | Evict stale short-term, demote inactive long-term |
| `touch-memory.js` | Bump `accessed` timestamp, optional promotion |
| `compact.js` | Distill memory into `.claude/rules/rem/` when index ≥20 |
| `rem-prep.js` | Pre-REM automation: transcript scan (memory + SR-IDs), promotions, compact check |
| `check-docs.js` | Doc freshness: detect stale README/AGENTS/CLAUDE at compact time |
| `task-engine.js` / `todo` CLI | Task management: `report` (default), `add`, `remove`/`rm`/`-r`, `help` |
| `task-lib.mjs` | Pure logic: scanMemoryForFindings, archiveResolved, parseExistingTasks, groupBy* |

## Files

| Path | Purpose |
|---|---|
| `lib.mjs` | Shared library: frontmatter, index, state, path security |
| `hooks/rem-hook.js` | Stop hook: gates /rem on session depth |
| `hooks/hooks.json` | Hook registration for Claude Code harness |
| `scripts/stamp-memory.js` | Memory system initialization |
| `scripts/prune-memory.js` | Eviction and demotion |
| `scripts/touch-memory.js` | Timestamp updates and promotion |
| `scripts/compact.js` | Memory compaction orchestrator |
| `scripts/rem-prep.js` | Pre-REM transcript scan and automation |
| `scripts/check-docs.js` | Doc freshness check at compact time |
| `skills/rem/SKILL.md` | /rem skill definition and workflow |
| `tests/lib.test.mjs` | Core library tests (55 tests) |
| `tests/rem-hook.test.mjs` | Hook logic tests (32 tests) |

## Tests

```shell
node --test cc-market/rem/tests/lib.test.mjs
node --test cc-market/rem/tests/rem-hook.test.mjs
```

A pre-commit hook in the cc-market repo runs all plugin tests before every commit.
