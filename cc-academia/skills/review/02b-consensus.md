# Step 02b — Consensus summary

Write `ongoing/<slug>/2-review/summary.md` — the shared ground truth every downstream agent reads **before** forming opinions. Runs **after** literature (step 02) so the summary folds in the research-landscape background.

## Inputs
- `ongoing/<slug>/1-paper-text/paper.md` (entry point — abstract + section index)
- `ongoing/<slug>/1-paper-text/md/*.md`
- `ongoing/<slug>/1-paper-text/INDEX.md` (figure/table map)
- `ongoing/<slug>/2-review/literature.md` — landscape + author background from step 02
- `ongoing/<slug>/review-config.md` — `lang:` (default `en`); write `summary.md` prose in this language
- `templates/summary-template.md`

## Output
- `ongoing/<slug>/2-review/summary.md`

## Steps

1. Read `literature.md` first for positioning, then `paper.md` for title + abstract, then walk through `md/` in order.
2. Fill in every section of `templates/summary-template.md`:
   - Title & venue/year, **Venue type** (see step 3), Problem, Claimed contribution, Method, Key experiments + headline numbers, Datasets, Baselines, Limitations admitted.
   - In **Claimed contribution** / positioning, weave in the `literature.md` landscape: where this paper sits relative to the closest prior work, and whether it is a natural evolution of the authors' track record.
3. **Determine venue type** — `conference` vs `journal`. Signals: venue name (Proceedings / Conf. / Symposium → conference; Transactions / Journal / Letters → journal), page count, "early access" / DOI form. Also record **domain** (e.g. power electronics, electric machines, control, ML). If genuinely unclear, write `unclear (assumed journal)` and flag it for the user. This field calibrates the `Obvious gaps` section and downstream reviewers.
4. Stay factual. **No critique here** — saved for step 04.
5. **`Obvious gaps`** section (last). List only objectively observable absences — not judgements. **Calibrate to venue type and domain**:
   - For **electrical-engineering conference papers** (electric machines, power electronics, drives): do **not** list missing hardware/physical experiments, missing public code, or missing public data as gaps — simulation-only validation and no code/data release are normal and acceptable at this venue. Only flag these if the paper itself claims a hardware result it does not show.
   - For **journal papers** (esp. IEEE Transactions in the same domain): experimental/hardware validation is typically expected — absence of it is a legitimate observable gap.
   - General examples that still apply to both:
     - "Single operating-point / single-seed results; no variance or sweep reported."
     - "No ablation isolating the contribution claimed in §1 bullet 2."
     - "Figure 4 caption claims robustness but no robustness benchmark is reported."
   Keep to bullets, 5–10 max. These are facts, not opinions. Downstream reviewers may pick them up and run.
6. Ensure `2-review/` directory exists, write to `ongoing/<slug>/2-review/summary.md`.
7. Show the summary to the user and confirm it matches their reading (including the venue type) before moving to step 03.

## Hard rule

If you cannot fill in a non-gap section from the PDF, write `Not stated in paper.` — never fabricate. For `Obvious gaps`, "none observed" is a valid answer if the paper really is thorough.
