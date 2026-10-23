# Sharp Review (锐评)

Post-feature code review with independent AI reviewers. Each run picks review profiles, gives each to a reviewer on a provider drawn from fabric `list_providers`, and merges their schema-bound findings into a structured task list. The review method (profiles, prompts, finding schema, merge rules) is versioned data in `method/`.

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
> The worker runs `plan.js`, calls each planned reviewer, and hands the raw results to
> `post-review.js`, which merges them by the method's rules.
>
> **On Codex:** install with `codex plugin add sharp-review@cc-market`. The Stop hook and the
> review skill both run on Codex, fanning out reviewers the same way. `/sharp-review` is a
> Claude slash-command; on Codex invoke the skill directly.

## Usage

Run `/sharp-review` after finishing a feature (Codex: invoke the skill). The Stop hook
evaluates deterministic change/source thresholds on every eligible turn and requests one
review pass. It does not invoke a hidden Claude classifier or a model just to decide depth.

### Modes

| Mode | Trigger | Reviewers |
|---|---|---|
| `none` | No fresh source crosses its configured threshold | 0 (skipped) |
| `once` | A fresh diff/docs/deps/codebase source fires | 1 pass using the method's provider/profile plan |

A pass can contain multiple independent reviewers. Further passes are an explicit manual
or Evolve workflow, not a separate model-classified Stop loop. Codex uses its built-in
worker; installed plugins still require normal hook trust and Fabric/provider authentication.

## Output

- `post-review.js --sink stdout` — the findings JSON instead of memory, a versioned contract (`method/findings-output.schema.json`)
- `.claude/memory/YYYY/MM/DD/sharp-review.md` — single memory entry per session with rem frontmatter (sole source of truth)
- `.claude/rules/MEMORY.md` — one index entry per session (upserted in-process via the bundled shared stamp module)
- `todo` / `todo report` — scan memory directly; no derived `tasks.md`

### Resolving Findings

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then rescan:

```bash
node cc-market/sharp-review/scripts/post-review.js --rescan --date YYYY-MM-DD
```

## How It Works

Full architecture and flow: Stop hook → source gate and atomic claim → skill (profile pick,
diff manifest, parallel reviewers, merge, memory write) → successful claim completion.
See **`AGENTS.md`** for the architecture diagram and component map.

### Wave Gate

Reviews are gated by accumulated code changes, not per-session. A new commit reviews early on a small change; once a ref is reviewed, only substantial new changes re-trigger. Skipped sessions preserve the reference point so changes add up until the threshold is met; the wave resets when HEAD moves to a new commit.

Thresholds are per-project configurable under `thresholds` in the tracked `.claude/sharp-review.json` (committed, so the tuning is shared — not device-local). Exact defaults, the full config schema, custom profiles, and weighting → `skills/sharp-review/reference/profiles-and-modes.md`.

REM and review share the state lock: a pending REM continuation defers review for that
session; an active checkout review defers REM. Waiting-input and Stop-continuation turns
do not recursively dispatch. Only successful post-review output credits reviewed hashes;
an unavailable/failed review does not falsely mark the checkout reviewed.

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
