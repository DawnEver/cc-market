# Step 04 — Fanout 锐评

Spawn one reviewer per angle **in parallel** via the `manuscript-review-fanout` workflow.

## Inputs
- `ongoing/<slug>/2-review/angles.md` (chosen angles + optional router overrides)
- `ongoing/<slug>/2-review/summary.md`, `ongoing/<slug>/2-review/literature.md` (if present)
- `1-paper-text/paper.md`, `1-paper-text/md/`, `1-paper-text/img/`, `1-paper-text/INDEX.md`
- `ongoing/<slug>/review-config.md` (for `lang:`)

## Output
- `ongoing/<slug>/2-review/critiques/<angle>.md` — one per angle

## Routing resolution

For each angle in `angles.md`:
1. If `Router override:` is non-empty, use it.
2. Else use the agent's frontmatter `router:` field.

| Router value | Provider | How invoked |
|--------------|----------|-------------|
| `sonnet-vision` | claude (Sonnet) | Direct via `agentType: reviewer-<angle>` inside the workflow |
| `takeover-codex` | codex | Claude Workflow relay → `mcp__plugin_fabric_fabric__call`; Codex bypass → `mcp__fabric__call` |
| `takeover-deepseek` | deepseek | Claude Workflow relay → `mcp__plugin_fabric_fabric__call`; Codex bypass → `mcp__fabric__call` |

Fabric tool names are host adapters: this Claude-only Workflow uses `mcp__plugin_fabric_fabric__call`; the Codex bypass uses `mcp__fabric__call` (or `mcp__fabric__fan_out` for a batch). Both use the `prompt` parameter (not legacy `userPrompt`).

## Exclusive routing rule

Each angle runs **exactly once** on one route:

- Local `claude` / `sonnet-vision`: a Claude named reviewer agent, or a Codex collaboration subagent using that agent's canonical prompt.
- External `codex` / `deepseek`: after explicit user confirmation of provider and model, Fabric only.
- If and only if the selected external Fabric route is unavailable or fails, offer an explicitly labelled same-model local fallback. It replaces the failed external result; it never runs alongside or duplicates a successful Fabric review.

Never launch both local and external routes for the same angle, and never silently convert an external route to local.

## Execution

Read `angles.md` and build the args:

```json
{
  "slug": "<slug>",
  "lang": "<en|zh from review-config.md>",
  "angles": [
    { "name": "novelty", "definition": "...", "provider": "claude", "model": "" },
    { "name": "methodology", "definition": "...", "provider": "deepseek", "model": "deepseek-v4-pro" }
  ]
}
```

Map router → provider: `sonnet-vision` → `claude`, `takeover-codex` → `codex`, `takeover-deepseek` → `deepseek`.

**If any angle uses external Fabric (codex/deepseek)**, pre-read the paper text to pass as `paperSections` in args. This prevents the relay agent from reading paper files directly, closing a prompt-injection vector where paper content could influence relay behavior before it builds the downstream prompt (H2).

Pre-read steps:
1. Read `ongoing/<slug>/1-paper-text/paper.md` for title + abstract.
2. Read `ongoing/<slug>/1-paper-text/md/` — prioritize Method, Theory, Experimental Setup / Results sections. Skip appendices unless an angle specifically needs them.
3. Concatenate into a single string `paperSections`. Cap at ~50K words; note truncation if applied.
4. Add `paperSections` to the workflow args object.

If all angles use direct Sonnet (`provider: "claude"`), `paperSections` can be omitted — the reviewer agents read files from disk directly.

**Before spawning, tell the user**: "Launching <N> reviewers in parallel via workflow — results will arrive in ~2–5 minutes."

Then invoke the workflow:

```
Workflow({ name: "manuscript-review-fanout", args: { slug, lang, angles, paperSections } })
```

### Host adaptation

- **Claude Code with `Workflow` available:** use the invocation above. Local angles use named agents; external angles use the workflow's current Fabric relay.
- **Codex local angles only (`claude` / `sonnet-vision`):** read `.claude/workflows/manuscript-review-fanout.js` and matching `.claude/agents/reviewer-<angle>.md` prompts, then spawn exactly one bounded collaboration subagent per local angle. Run those local angles in parallel, providing the workflow safety boundaries, paper inputs, language, format and exact output path. For a custom local angle use the workflow's generic inline prompt.
- **Codex external angles only (`codex` / `deepseek`):** do not spawn a collaboration reviewer. After user confirmation, invoke exactly one Fabric route using `mcp__fabric__call` per angle or one `mcp__fabric__fan_out` batch. Preserve provider/model routing and pass review text as `prompt`.
- If Fabric or the provider is unavailable, report it before launch and offer an explicit same-model fallback using an isolated Codex collaboration subagent with the same prompt. Label this in the completion report; do not pretend it was cross-model review.
- On every host, verify all critique files and apply the partial-recovery protocol below.

The workflow handles:
- Parallel execution of all reviewers via `parallel()`
- Direct Sonnet reviewers via `agentType: reviewer-<angle>` (reads files from disk)
- External reviewers via relay agent → Fabric `call` (inlines paper content)
- Structured output validation via schema
- Writing critiques to `critiques/<angle>.md`

## After fanout

For the Codex path, replace prompt-only schema trust with deterministic validation after all writers finish:

```bash
python scripts/validate_workflow_output.py fanout "ongoing/<slug>/2-review/critiques" <angle-1> <angle-2> ...
```

This checks that the directory's `*.md` set equals the complete expected angle set (so stale critiques cannot leak into aggregation) and validates each numbered point's `Evidence`, constrained `Severity`, and `Suggested action`. A non-zero exit is a failed/partial fanout and must enter the recovery protocol; it must not advance to step 05.

Wait for the workflow to complete. Check every expected `2-review/critiques/<angle>.md` exists and is non-empty.

**Partial-recovery protocol**: if the workflow returns fewer results than angles, or critique files are missing:

1. **Retry missing reviewers** — re-invoke the workflow with only the failed angles (recommended). Do not advance until the full expected set validates.
2. **Approve a reduced set** — only after the user explicitly accepts the available subset, write `2-review/fanout-approved.json`:

   ```json
   {"user_approved": true, "approved_angles": ["novelty", "experiments"], "skipped_angles": ["methodology"]}
   ```

   Move stale/non-approved `*.md` out of `critiques/`, then validate the exact approved subset and record:

   ```bash
   python scripts/validate_workflow_output.py fanout "ongoing/<slug>/2-review/critiques" --approval "ongoing/<slug>/2-review/fanout-approved.json" novelty experiments
   ```

   Only successful validation permits step 05 to aggregate a reduced set. Record skipped angles in `critiques.md`.
3. **Keep partial for later retry** — remain at step 04 and rerun later; do not create placeholder critique files and do not advance to aggregation.

Do not silently enter step 05 with a partial set.
