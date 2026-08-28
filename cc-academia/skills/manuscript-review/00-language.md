# Step 00 — Intermediate-file language

Runs once at the very start of the pipeline (before ingest). Lets the user pick the language of the **intermediate** review artifacts.

## Scope

The language choice applies to the generated intermediate files:
- `2-review/literature.md`
- `2-review/summary.md`
- `2-review/critiques/*.md` and `2-review/critiques.md`
- `3-response/draft.md`

It does **not** change:
- `1-paper-text/*` — ingested verbatim from the PDF (whatever language the paper is in).
- `3-response/final.md` — the publishable reviewer comments. These are produced by `manuscript-polisher-english` and are **always plain-text English**, since they are submitted to the venue. (If the user ever needs a Chinese final, that is a separate explicit request.)

## Steps

1. **Resume check**: if `ongoing/<slug>/review-config.md` exists and contains a `lang:` line, read it and skip the gate. Otherwise continue.
2. Ask the user (use `AskUserQuestion`): which language for the intermediate review files? Options:
   - **English** (default)
   - **中文 (Chinese)**
3. Write the choice to `ongoing/<slug>/review-config.md`:
   ```markdown
   lang: en   # or: zh
   ```
   Create the `ongoing/<slug>/` directory if needed.
4. Proceed to step 01 (ingest).

## How downstream steps use it

Every step that writes an intermediate file (02, 02b, 04, 05, 06) reads `lang:` from `review-config.md` and writes that file's prose in the chosen language. Section headings/keys may stay in their template form; the analytical prose is what switches. If `review-config.md` is missing (e.g. an older run), default to `en`.
