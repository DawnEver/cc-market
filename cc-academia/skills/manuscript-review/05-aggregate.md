# Step 05 — Aggregate critiques

Merge `critiques/*.md` into a single ranked `critiques.md`, then present a numbered menu for the user to select which issues to include in their draft.

## Inputs
- `ongoing/<slug>/2-review/critiques/*.md`
- `ongoing/<slug>/2-review/fanout-approved.json` — optional explicit user approval for a reduced angle set
- `ongoing/<slug>/review-config.md` — `lang:` (default `en`); write `critiques.md` prose in this language

## Output
- `ongoing/<slug>/2-review/critiques.md`

## Steps

0. Determine and validate the input set before reading critique prose:
   - Normally, use every selected angle in `angles.md` and require the critique directory to match exactly.
   - If `fanout-approved.json` exists, use only its ordered `approved_angles`, require `user_approved: true`, and retain `skipped_angles` for the aggregate note.
   - Run `python scripts/validate_workflow_output.py fanout "ongoing/<slug>/2-review/critiques" [--approval "ongoing/<slug>/2-review/fanout-approved.json"] <approved-angle> ...`.
   - Stop on any error. Never read unexpected/stale `*.md`, aggregate a placeholder/PENDING file, or infer approval from file presence.
1. Read exactly the validated `critiques/<approved-angle>.md` files. For a reduced set, add a prominent `Skipped angles (user approved): ...` note to `critiques.md`.
2. Assign each **angle** a descriptive prefix based on its name from `angles.md`:
   - `N` for **novelty**
   - `M` for **methodology**
   - `E` for **experiments**
   - `F` for **freestyle**
   - For custom angles, derive a prefix from the first letter or abbreviation of the angle name (e.g. `S` for soundness, `W` for writing, `R` for reproducibility). If two angles would collide on the same letter, use 2-letter abbreviations (e.g. `So` for soundness, `St` for statistical-rigour).
3. Within each angle, **preserve the source file's sequential numbering** (1, 2, 3, …). Do NOT re-sort or re-number. The source file already orders points by severity (Major → Minor → Nit); keep that order.
4. **Dedupe across angles — preserve original numbers**:
   - If two (or more) angles raise the same issue, keep it under the **primary** angle (first one in reading order: novelty → methodology → experiments → freestyle → custom) at its original number.
   - In the secondary angle(s), mark that number slot as **skipped** with a cross-reference to the primary code.
   - This preserves a 1:1 mapping between source-file point #N and aggregate code N<N> — no numbers shift, no re-ordering.
   - Format for a skipped slot:
     ```markdown
     ### M5 · ⏭ SKIP — 与 N3 重复
     <one-line summary. The full critique is under N3.>
     ```
5. **Flag conflicts**: if one angle calls X a strength and another calls X a weakness, mark both points with `⚡ CONFLICT` and cross-reference. Conflicts are NOT deduplicated — both sides stay.
5b. **Preserve image-verify flags**: any critique about *figure rendering* (blurriness, low resolution, truncation — possible extraction artifacts) keeps a `🔍 VERIFY` marker and **retains the image path** in its `Evidence:` line, so the user can open the file and check against the original PDF. Do not silently drop or promote these to firm defects.
6. Write `critiques.md` following `templates/critiques-template.md`.
   Key invariant: **N3 in `critiques.md` = point #3 in `critiques/novelty.md`**. No exceptions.

7. After writing the file, display a **compact selection menu** inline to the user:

   ```
   ── Critiques ready ──────────────────────────────
   N · Novelty
     N1 [Major] <point title>
     N2 [Minor] <point title>
     N3 [Major] <point title>
     N4 [Minor] ⏭ SKIP — 与 E2 重复
   M · Methodology
     M1 [Major] <point title>
     ...
   ⚡ Conflicts: N3 vs M2

   Type codes to include (skips are auto-excluded):
   e.g. N1 N2 E1 F1
   ─────────────────────────────────────────────────
   ```

   ⏭ SKIP entries are shown in the menu for transparency but are **auto-excluded** from selection — the user does not need to skip them manually.

8. **Wait for the user's selection.** Do not proceed to step 06 until the user responds with selection codes (or `all` / `none`). `all` includes every non-skip point.
