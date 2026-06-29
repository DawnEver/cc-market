# Sharp Review — Direct Fan-Out Procedure (reference)

On-demand detail for the reviewer fan-out (SKILL.md Step 3): a Claude Code worker subagent,
or a Codex worker.

## Fan-out tool preference

**Primary: `mcp__plugin_takeover_takeover__call_model`** — calls external provider APIs
directly with no safety-classifier dependency. Works on both Claude Code and Codex.

**Fallback: `Agent` tool** (Claude Code) or `spawn_agent` (Codex) — spawns a subagent per
reviewer. These go through the safety classifier and may fail transiently. Use only when
the takeover MCP tool is not available.

Call each active reviewer in sequence via takeover, collect their `{ "findings": [...] }`
responses, and build `raw.json`. A reviewer whose takeover call fails or returns no valid
JSON → `null` in `rawResults`.

## Empty-diff gate

If ALL profiles honor the diff manifest (all `mode === null`) AND `mode === "empty"`, report
`Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop.
Agent-mode profiles (`architecture`/`docs`/`deps`) ignore empty and always proceed — if at
least one agent-mode profile is in the pick, the review runs.

## Reviewer rotation (seed mod 3)

2 of 3 reviewers run, picked by `seed mod 3` (combos AB/AC/BC) on the `result.seed` from
`diff-manifest.js`. Same-day rounds rotate the pair:

| seed % 3 | Active pair |
|----------|-------------|
| 0 | A (Codex) + B (DeepSeek) |
| 1 | A (Codex) + C (Opus) |
| 2 | B (DeepSeek) + C (Opus) |

Provider mapping: A → `codex`, B → `deepseek`, C → `claude`.

Each active reviewer is assigned **a different profile** — the profiles array from
`pick-profile.js` is shuffled, so reviewer[i] gets profiles[i]. Two reviewers review
through two different lenses, at the same 2-reviewer cost.

## Step-by-step procedure

1. Pick the active reviewer pair via `seed mod 3` using `result.seed`.
2. Build each reviewer's prompt from **its assigned profile's** framing/scope, using the
   shared diff/manifest payload (Step 2) for diff-sourced profiles.
   **Call each active reviewer** via `mcp__plugin_takeover_takeover__call_model`
   (`provider="codex"|"deepseek"|"claude"`, `mode="review"|"agent"`) with the review
   prompt as `userPrompt`. Extract `{ "findings": [...] }` from the response JSON.
   If the takeover tool is unavailable, fall back to the `Agent` tool (Claude Code) or
   `spawn_agent` (Codex) — one worker per reviewer.
   Each reviewer must return ONLY `{ "findings": [...] }` matching the finding schema (see
   `reference/profiles-and-modes.md` > Reviewer schema).
3. Collect the raw per-reviewer results into a `raw.json`:

   ```json
   {
     "reviewers": [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"},{"key":"C","name":"Opus"}],
     "active":    [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"}],
     "profiles":  [{"key":"adversarial","label":"adversarial review (对抗性审查)",…}, {"key":"diff","label":"diff review",…}],
     "profileLabel": "adversarial review (对抗性审查) + diff review",
     "rawResults": [ {"findings":[...]}, {"findings":[...]} ]
   }
   ```
   `rawResults[i]` aligns positionally with `active[i]` and `profiles[i]`; a failed reviewer is `null`.
4. Hand the raw.json to `post-review.js --raw` (Step 4) — it runs the shared merge/render and
   writes the memory entry. Do NOT merge or assign `SR-` ids yourself; the shared `lib.mjs`
   owns that so every host produces byte-identical output.

## Calling post-review

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/post-review.js" --date <YYYY-MM-DD> --raw "$env:TEMP/claude-sharp-review/raw.json"
```

If `$env:CLAUDE_PLUGIN_ROOT` is empty, use the Step 0 fallback (check `$env:TEMP/claude-sharp-review/plugin-root.txt`) before running this command.

On Windows: write `raw.json` with the Write tool (not Bash redirection) — see SKILL.md Step 4.
