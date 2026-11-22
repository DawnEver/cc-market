# Sharp Review (sharp review)

Post-feature code review with independent AI reviewers. Each run picks review profiles, gives each to a reviewer on a provider drawn from fabric `list_providers`, and merges their schema-bound findings into a structured task list. The review method (profiles, prompts, finding schema, merge rules), its planner and its merge are ai-lab's (`python -m ai_lab.review.plan` / `.merge`); this plugin keeps none of them.

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

> A review runs **entirely** inside a dispatched worker subagent, so the
> diff/reviewer/merge noise never touches the main session — only the one-line summary returns.
> The worker runs `plan.js`, calls each planned reviewer, and hands the raw results to
> `post-review.js`, which has ai-lab merge them by the method's rules.
>
> **On Codex:** install with `codex plugin add sharp-review@cc-market`. The review skill runs
> on Codex, fanning out reviewers the same way. `/sharp-review` is a Claude slash-command; on
> Codex invoke the skill directly.

## Usage

Run `/sharp-review` after finishing a feature (Codex: invoke the skill). The plugin ships no
hooks: a review runs only when asked for, by you or by a workflow such as Evolve. One run is
one pass of several independent reviewers; Codex uses its built-in worker and needs
Fabric/provider authentication.

## Output

- `post-review.js --sink stdout` — the findings JSON instead of memory, a versioned contract (ai-lab's `findings-output.schema.json`)
- `output/logs/YY/MM/DD/sharp-review/sharp-review.md` — the run's report (regenerable output; keep a finding by moving it into `.claude/memory/`)
- `.claude/rules/MEMORY.md` — one index entry per session (upserted in-process via the bundled shared stamp module)

### Resolving Findings

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then rescan:

```bash
node cc-market/sharp-review/scripts/post-review.js --rescan --date YYYY-MM-DD --file <review.md>
```

## How It Works

Full architecture and flow: `/sharp-review` → worker subagent → skill (profile pick, diff
manifest, parallel reviewers, merge, report write). See **`AGENTS.md`** for the architecture
and component map. The tracked `.claude/sharp-review.json` (committed, so the tuning is
shared — not device-local) holds profile weights, custom profiles, the inline-diff limit and
providers → `skills/sharp-review/reference/profiles-and-modes.md`.

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
