# Sharp Review — Direct Fan-Out Procedure (reference)

On-demand detail for whoever runs without the `Workflow` tool — i.e. the **standard path**: a
Claude worker subagent dispatched by the Execution-mode preamble (fans out via the `Agent`
tool), or a Codex host (fans out via `spawn_agent`). Only an inline Generalized-Mode caller in
the main loop skips this and uses the `Workflow` tool (Step 3a).

## Empty-diff gate

Same as 3a: if the profile honors the diff manifest AND `mode === "empty"`, report
`Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop.
Agent-mode profiles (`architecture`/`docs`/`deps`) ignore empty and always proceed.

## Reviewer rotation (seed mod 3)

2 of 3 reviewers run, picked by `seed mod 3` (combos AB/AC/BC) on the `result.seed` from
`diff-manifest.js`. Same-day rounds rotate the pair:

| seed % 3 | Active pair |
|----------|-------------|
| 0 | A (Codex) + B (DeepSeek) |
| 1 | A (Codex) + C (Opus) |
| 2 | B (DeepSeek) + C (Opus) |

Provider mapping: A → `codex`, B → `deepseek`, C → `claude`.

## Step-by-step procedure

1. Pick the active reviewer pair via `seed mod 3` using `result.seed`.
2. Build each reviewer's prompt from the same scope/diff/manifest payload (Step 2) and fan
   them out **in parallel** — one worker per reviewer via the `Agent` tool (Claude worker
   subagent) or `spawn_agent` (Codex), or the takeover `call_model` MCP tool
   (`provider="codex"|"deepseek"|"claude"`, `mode="review"|"agent"`).
   Each reviewer must return ONLY `{ "findings": [...] }` matching the finding schema (see
   `reference/profiles-and-modes.md` > Reviewer schema).
3. Collect the raw per-reviewer results into a `raw.json`:

   ```json
   {
     "reviewers": [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"},{"key":"C","name":"Opus"}],
     "active":    [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"}],
     "profileLabel": "diff review",
     "rawResults": [ {"findings":[...]}, {"findings":[...]} ]
   }
   ```
   `rawResults[i]` aligns positionally with `active[i]`; a failed reviewer is `null`.
4. Hand the raw.json to `post-review.js --raw` (Step 4) — it runs the shared merge/render and
   writes the memory entry. Do NOT merge or assign `SR-` ids yourself; the shared `lib.mjs`
   owns that so both hosts produce byte-identical output.

## Calling post-review

```powershell
node "<CLAUDE_PLUGIN_ROOT>/scripts/post-review.js" --date <YYYY-MM-DD> --raw "$env:TEMP/claude-sharp-review/raw.json"
```

On Windows: write `raw.json` with the Write tool (not Bash redirection) — see SKILL.md Step 4.
