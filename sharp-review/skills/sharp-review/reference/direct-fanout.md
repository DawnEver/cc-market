# Sharp Review — Direct Fan-Out Procedure (reference)

On-demand detail for the reviewer fan-out (SKILL.md Step 3): a Claude Code worker subagent,
or a Codex worker.

## Fan-out tool preference

**Primary: `mcp__plugin_fabric_fabric__call`** — calls external provider APIs
directly with no safety-classifier dependency. Works on both Claude Code and Codex.

**Fallback: `Agent` tool** (Claude Code) or `spawn_agent` (Codex) — spawns a subagent per
reviewer. These go through the safety classifier and may fail transiently. Use only when
the fabric MCP tool is not available.

Call each active reviewer in sequence via takeover, collect their `{ "findings": [...] }`
responses, and build `raw.json`. deepseek/claude return JSON directly; **codex review-mode
returns prose** — normalize it per § Codex prose normalization below, which also defines the
single `[]`-vs-`null` rule for all reviewers.

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
   **Call each active reviewer** via `mcp__plugin_fabric_fabric__call`
   (`provider="codex"|"deepseek"|"claude"`, `mode="review"|"agent"`, `resultMode="full"`)
   — `resultMode` defaults to `"summary"` which TRUNCATES output; always set `"full"`.
   Pass the review prompt as `prompt`. Extract `{ "findings": [...] }` from the response — directly for
   deepseek/claude, or via § Codex prose normalization for codex review-mode.
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

## Codex prose normalization

**Canonical rule** — both the worker agent (`agents/sharp-review.md`) and SKILL.md Step 3 link
here; do not restate it elsewhere.

Codex with `provider="codex"`, `mode="review"` uses its native review endpoint, which **ignores
the JSON instruction and returns prose**. deepseek/claude return `{ "findings": [...] }`
directly — use as-is. For codex, the host normalizes the prose:

1. **Parse** each issue codex raises into a finding object `{ severity, file, summary, category,
   suggestion, detail }` — `severity` ∈ `HIGH|MEDIUM|LOW|INFO`, `category` ∈ `Bug|Feature|
   Performance`.
2. **Schema-validate**: drop any parsed entry missing a required field (`severity`, `summary`,
   `category`); do not invent `file`/severity not supported by the prose. Only validated
   findings enter `rawResults`.
3. **`[]` vs `null` (applies to every reviewer, not just codex):**
   - `[]` — the reviewer **explicitly** signalled a clean pass (codex: an affirmative "no
     material issues" statement; deepseek/claude: an empty `findings` array).
   - `null` — the takeover call errored, OR the output is empty / truncated / off-topic /
     unparseable with no extractable findings **and no affirmative clean signal**. Never map an
     ambiguous non-affirmative response to `[]` — that silently hides a reviewer failure
     (`merge` treats `null` = failed, `[]` = passed-clean).

On Windows: write `raw.json` with the Write tool (not Bash redirection) — see SKILL.md Step 4.
