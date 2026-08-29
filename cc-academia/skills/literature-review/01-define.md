# Step 01 — Define topic & scope

交互式定义研究主题和范围。

## Steps

1. **Derive slug** from topic name (lowercase, non-alphanum → `-`).

2. **Create workspace**:
   ```bash
   uv run --project "<plugin-root>" lit-review init "<topic>"
   ```
   Creates `workspaces/<slug>/` with `workspace.toml` and all subdirectories.

3. **Agent helps user define the research brief**. Work through interactively:
   - `original_request` — the user's question in their own words
   - `research_objective` — focused, answerable statement
   - `inclusion_criteria` — what makes a paper eligible
   - `exclusion_criteria` — what disqualifies a paper
   - `constraints` (year range, content types — agent proposes reasonable defaults)
   - `concepts` — taxonomy table. Each: `concept_id`, `role`, `term`, `synonyms`, `rationale`, `source`, `selected`

4. **Show concept table** as keyword grid. Let user edit. Iterate until satisfied.

5. **Write** `workspaces/<slug>/research_brief.toml`.

6. **User confirms** the brief. Verbal OK is sufficient — no crypto ceremony.

7. Proceed to step 02 (search).

## Existing workspace

If `workspaces/<slug>/` already exists, present current state and ask: continue, revise, or start fresh.
