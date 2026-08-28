# Step 02 — Literature context & author background

Search for the most relevant prior work and profile the authors via the `manuscript-review-literature` workflow. This runs **before** the consensus summary (step 02b) so the summary can fold this background into the paper's positioning.

## Inputs
- `ongoing/<slug>/1-paper-text/paper.md` — full paper text (title, abstract, section index)
- `ongoing/<slug>/1-paper-text/md/*.md` — per-section text (related-work / introduction)
- `ongoing/<slug>/2-review/angles.md` — optional `literature_n:` override (default N = 5)

## Output
- `ongoing/<slug>/2-review/literature.md` — written in the language from `review-config.md` (`lang:`, default `en`)

## Execution

Read `review-config.md` for `lang:`. Check `angles.md` for `literature_n:` if the file exists.

Invoke the workflow:

```
Workflow({ name: "manuscript-review-literature", args: { slug, lang, n } })
```

### Host adaptation

- **Claude Code with `Workflow` available:** invoke the workflow above unchanged.
- **Codex (no `Workflow` runtime):** treat `.claude/workflows/manuscript-review-literature.js` as the canonical executable specification. Read its prompts, schemas, ordering, sanitization and output contract. Reproduce Extract → Search → Merge with Codex tools: use collaboration subagents for independent bounded phases/searches and the web search tool for its `WebSearch` calls. Run independent searches concurrently where possible, then merge after all results return. Write the same `literature.md`; do not fork the workflow merely to translate syntax. If web access is unavailable, state the gap and either skip this optional step with user approval or produce clearly labelled paper-internal context only—never invent results.

The workflow runs three phases:

For the Codex path, enforce the on-disk schema after writing (not merely existence or prompt compliance):

```bash
python scripts/validate_workflow_output.py literature "ongoing/<slug>/2-review/literature.md"
```

A non-zero exit blocks step 02b; repair or rerun the merge until validation passes.

| Phase | What | How |
|-------|------|-----|
| **Extract** | Read paper → extract references (up to 15), build 2–3 IEEE queries, identify authors to profile | 1 agent with schema |
| **Search** | IEEE Xplore queries + author background lookups | `parallel()` — all WebSearch calls run concurrently |
| **Merge** | Deduplicate, rank top N, write `literature.md` | 1 agent |

## Resume

**Orchestrator gate**: If `ongoing/<slug>/2-review/literature.md` is non-empty, skip this step entirely and proceed to step 02b. The workflow is stateless — the orchestrator enforces the skip via the resume table in `SKILL.md`.
