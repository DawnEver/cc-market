# Step 01 — Define topic & scope

交互式定义研究主题和范围。

## Steps

1. **Derive slug** from topic name (lowercase, non-alphanum → `-`).

2. **Ask the output language** (`AskUserQuestion`; Codex: ask in chat): English (default)
   or 简体中文 (`zh-CN`); any other BCP 47 tag is accepted. If the user already wrote the
   request in Chinese, still ask — do not infer. See `SKILL.md` § Output language.

3. **Create workspace**:
   ```bash
   uv run --project "<plugin-root>" lit-review init "<topic>" --language <tag>
   ```
   Creates `ongoing/<slug>/` with `workspace.toml` and all subdirectories.

4. **Agent helps user define the research brief**. Work through interactively:
   - `original_request` — the user's question in their own words
   - Free-text fields (`research_objective`, criteria, `rationale`) in the output language; `concept_id`, `role` and search `term`/`synonyms` stay English
   - `research_objective` — focused, answerable statement
   - `inclusion_criteria` — what makes a paper eligible
   - `exclusion_criteria` — what disqualifies a paper
   - `constraints` (year range, content types — agent proposes reasonable defaults)
   - `concepts` — taxonomy table. Each: `concept_id`, `role`, `term`, `synonyms`, `rationale`, `source`, `selected`

5. **Show concept table** as keyword grid. Let user edit. Iterate until satisfied.

6. **Write** `ongoing/<slug>/research_brief.toml`.

7. **User confirms** the brief. Verbal OK is sufficient — no crypto ceremony.

8. Proceed to step 02 (search).

## Existing workspace

If `ongoing/<slug>/` already exists, present current state and ask: continue, revise, or start fresh.
