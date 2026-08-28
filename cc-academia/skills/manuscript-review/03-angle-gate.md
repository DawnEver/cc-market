# Step 03 — Angle gate ⭐

Pick the 锐评 angles for this paper. **User gate** — iterate until they approve.

## Inputs
- `templates/default-angles.md` — seed angles (now compact: novelty, methodology, experiments, freestyle)
- `critiques-library/angles.md` — accumulated angle library (hit-counts, samples)
- `ongoing/<slug>/2-review/summary.md` (especially `Obvious gaps`)
- `ongoing/<slug>/2-review/literature.md` — landscape context from step 02
- Each reviewer agent's frontmatter `router:` (the **default** routing)

## Output
- `ongoing/<slug>/2-review/angles.md`

## Steps

1. Read `templates/default-angles.md`. Read `critiques-library/angles.md` if it exists; rank by hit-count.
2. Read `2-review/literature.md` if it exists. Note whether the literature search found any close prior work that suggests strengthening the novelty angle, or identified a missing baseline that implies experiments angle is critical.
3. Look at `summary.md` (especially `Obvious gaps`) and decide which default/library angles matter most for **this** paper.
4. Present candidate angles to the user via `AskUserQuestion` (multi-select). Include:
   - All default angles listed in `templates/default-angles.md`
   - Top 2–3 from the library by hit-count, if they're distinct from defaults

   **Each option must include the angle's definition inline in the `description` field.** For example:
   - Option label: `novelty`
   - Description: `Novelty & contribution — assesses whether the core idea is genuinely new, how it differs from prior work, and whether the claimed contribution holds up.`
   - Option label: `methodology`
   - Description: `Methodology & soundness — scrutinises the technical approach: assumptions, derivations, soundness of proofs, reproducibility, and whether the method is correctly applied.`
   - Option label: `experiments`
   - Description: `Experiments & figures — evaluates experimental setup, baselines, ablation design, statistical rigour, and whether figures/tables support the claims.`
   - Option label: `freestyle`
   - Description: `Freestyle / wildcard — open-ended critique from any angle not covered above (writing clarity, ethics, significance, missing references, presentation).`

   This way the user sees what each angle covers when they make their selection, without needing to flip to another file.
5. Let the user add / remove / edit. Iterate until they confirm.
6. Write `angles.md`:
   ```markdown
   # Angles for <slug>

   ## novelty
   Definition: <may customise>
   Router override: <leave blank to use agent default, or set sonnet-vision | takeover-codex | takeover-deepseek>

   ## methodology
   ...
   ```
7. **Routing is read from agent frontmatter by default.** Only fill `Router override` when the user explicitly wants something different for this paper. Step 04 uses: override-if-set, else frontmatter default.

## Hard rule

Never proceed to step 04 without an explicit user OK on the angle list.

**On resume**: if `angles.md` already exists and the pipeline is resuming into step 03 (e.g. after a `--restart-from 03`), show the previously chosen angles to the user and re-confirm before proceeding. Do not silently reuse the old selection — the user may want to adjust based on what they've learned.
