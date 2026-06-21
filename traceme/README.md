# traceme

Local-first personal observability for Claude Code — daily token/cost reports, tool & skill
usage stats, per-project breakdowns, and encrypted multi-device sync.

> **Codex: not supported (and won't be).** traceme derives everything from Claude Code's
> transcript JSONL at `~/.claude/projects/**/*.jsonl`. Codex stores its sessions in SQLite
> with a different shape, so there is nothing for traceme to scan — it is out of scope by
> design. Install traceme on Claude Code only; do not `codex plugin add traceme`.

## Install

```shell
/plugin install traceme@cc-market
```

This registers SessionStart / Stop / SessionEnd hooks that pull cross-device snapshots, scan
transcripts incrementally, and push an encrypted daily snapshot.

## Usage

```shell
/traceme              # daily token/cost report
```

The `/traceme` skill drives the CLI (`scripts/traceme-cli.mjs`): `report`, `stats`, `sync`,
`export`, `rescan`, `insights`, and `dashboard` (interactive HTML). See `skills/traceme/SKILL.md`
for the full command surface.

## How It Works

The Claude Code transcripts are the source of truth — every assistant message carries its
model and full token `usage`, every `tool_use` names the tool. traceme scans them
incrementally into SQLite (`node:sqlite`, zero npm deps) and derives all reports at query
time. Architecture and file map → `AGENTS.md`.

## Tests

```shell
node --test cc-market/traceme/tests/*.test.mjs
```

A pre-commit hook in the cc-market repo runs all plugin tests before every commit.
