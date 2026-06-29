# Sharp Review (锐评)

Post-feature code review with 3 independent AI reviewers. Each reviewer is constrained by JSON Schema; findings are cross-checked, merged, and synced to a structured task list.

## Install

Enable the plugin in `claude_settings.json`:

```json
{
  "enabledPlugins": {
    "sharp-review@cc-market": true
  }
}
```

Then run setup to symlink:

```bash
node scripts/setup/setup.js
```

> The standard trigger runs the **entire** review inside a dispatched worker subagent, so the
> diff/reviewer/merge noise never touches the main session — only the one-line summary returns.
> The worker fans out reviewers directly and feeds `post-review.js --raw` the shared
> merge/render.
>
> **On Codex:** install with `codex plugin add sharp-review@cc-market`. The Stop hook and the
> review skill both run on Codex, fanning out reviewers the same way. `/sharp-review` is a
> Claude slash-command; on Codex invoke the skill directly.

## Usage

Run `/sharp-review` after finishing a feature. The Stop hook automatically classifies review depth and triggers the skill when appropriate.

### Modes

| Mode | Trigger | Reviewers |
|---|---|---|
| `none` | Trivial/doc-only tasks | 0 (skipped) |
| `once` | Moderate code changes | 1 pass |
| `multi` | Complex/risky changes | 2 parallel (picked from 3 backends) + merge |

## Output

- `.claude/memory/YYYY/MM/DD/sharp-review.md` — single memory entry per session with rem frontmatter (sole source of truth)
- `.claude/rules/MEMORY.md` — one index entry per session (stamp-memory.js)
- `todo` / `todo report` — scan memory directly; no derived `tasks.md`

### Resolving Findings

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then rescan:

```bash
node cc-market/sharp-review/scripts/post-review.js --date YYYY-MM-DD --rescan
```

## How It Works

Full architecture and flow: Stop hook → classify → skill (profile pick, diff manifest, parallel reviewers, merge, memory write). See **`AGENTS.md`** for the architecture diagram and component map.

### Wave Gate

Reviews are gated by accumulated code changes, not per-session. A new commit reviews early on a small change; once a ref is reviewed, only substantial new changes re-trigger. Skipped sessions preserve the reference point so changes add up until the threshold is met; the wave resets when HEAD moves to a new commit.

Thresholds are per-project configurable under `thresholds` in the tracked `.claude/sharp-review.json` (committed, so the tuning is shared — not device-local). Exact defaults, the full config schema, custom profiles, and weighting → `skills/sharp-review/reference/profiles-and-modes.md`.

### Large Diffs

When a change touches many files or produces a very large diff, sharp review automatically switches to **agent mode**:

- **Smart filtering**: lockfiles (`package-lock.json`, `Cargo.lock`, etc.), minified/build/generated files, binary files, and pure renames are automatically excluded from review — reducing noise and preventing them from inflating the diff size.
- **Review mode** (default, ≤ `inlineDiffLimit` chars): the full diff is inlined into reviewer prompts — best signal quality.
- **Agent mode** (> `inlineDiffLimit` chars): only a manifest (file table + hunk header summary) is sent to reviewers. Each reviewer gets full tool access via takeover `mode="agent"` and explores autonomously — running `git diff -- <path>`, reading source files, tracing call chains. Two reviewers still cross-validate findings.
- **Empty mode**: if all files are filtered out, the review is skipped entirely.

Configure the threshold in `.claude/sharp-review.json`:
```json
{ "inlineDiffLimit": 20000 }
```
Default is 20000 characters (~5k tokens). Units are **chars** (not lines) because chars track actual context window cost — line counts mislead on minified or long-line content.
