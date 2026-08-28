# Step 08 — Archive

Freeze the review, then update global style + angle library, with dedup and rolling caps.

## Inputs
- `ongoing/<slug>/` (everything)
- `style/profile.md` (may not exist yet)
- `critiques-library/angles.md` (may not exist yet)

## Output
- `archived/YYMMDD/<slug>/` — full move of `ongoing/<slug>/` (date-named parent for chronological sorting)
- Updated `style/profile.md` (capped growth)
- Updated `critiques-library/angles.md` (deduped)
- Optional `archived/YYMMDD/<slug>/postmortem.md`

## Steps

1. **Immediate confirmation gate (mandatory).** Immediately before any archive
   directory creation, move, or profile/library mutation, show the exact source
   and destination paths and ask the user to confirm this archive operation now.
   Prior approval of `final.md`, a generic instruction to finish, or confirmation
   from a previous turn is not sufficient. Do not execute anything below until
   the user explicitly confirms. If they decline or do not answer, stop at step
   08 and leave all files unchanged.

2. **Move folder** into a date-named parent directory for chronological sorting:
   ```bash
   mkdir -p "archived/$(date +%y%m%d)" && mv "ongoing/<slug>" "archived/$(date +%y%m%d)/<slug>"
   ```
   The archive path is now `archived/YYMMDD/<slug>/` (e.g. `archived/260530/attention-is-all-you-need/`).

3. **Update voice profile** — spawn `manuscript-polisher-english` with:
   - Read `archived/YYMMDD/<slug>/3-response/final.md`.
   - Read current `style/profile.md` if it exists.
   - Profile structure has TWO regions:
     ```
     ## Synthesised voice
     <8–15 bullets that any future polish run can use as a style guide>

     ## Recent samples
     ### <slug-N> (<date>)
     <5–10 bullets of distinctive turns of phrase, structure, hedging from this paper>
     ...
     ```
   - Append a new `### <slug> (<date>)` block under `Recent samples`.
   - **Rolling cap**: keep only the most recent **10** sample blocks. Older blocks are summarised into `Synthesised voice` (bullets that persist), then dropped from `Recent samples`. The polisher agent does this merge — read the to-be-dropped block, distill any pattern not already in `Synthesised voice`, append to `Synthesised voice`, delete the old block.
   - Write back to `style/profile.md`.

4. **Update angle library** with dedup and rolling cap:
   - Read `archived/YYMMDD/<slug>/angles.md` and `archived/YYMMDD/<slug>/3-response/final.md`.
   - For each angle used:
     - If the angle name matches an existing entry exactly, bump `hit-count`.
     - Otherwise, before adding as new, **semantic dedup check**: compare against existing top-10 entries by name + description. If the new angle is essentially the same as an existing one (e.g. "dataset bias" vs "data bias" vs "demographic skew in data"), bump that existing entry's count and add the new wording as an `alias` under it instead of creating a new entry.
   - If `freestyle` produced a critique the user kept (visible in `final.md`):
     - Ask the user for the angle name + one-line description.
     - Run the same dedup check before adding.
     - Add as a new entry with hit-count=1 and a representative sample paragraph quoted from `final.md`, OR bump+alias on an existing entry.
   - Library entry shape:
     ```markdown
     ### <name>
     hit-count: N
     aliases: <comma-separated alternative names>
     description: <one line>
     sample: > <quoted paragraph from a final.md>
     ```
   - **Rolling cap**: keep the library at **30** entries max. When exceeded, drop the lowest hit-count entry (oldest last-used breaks ties). This prevents unbounded growth while preserving high-signal angles.
   - Write to `critiques-library/angles.md`.

5. **Postmortem (optional, user-driven)**. After archive, offer the user:
   > Want to score each weakness in `final.md` as `valid` / `partial` / `hallucinated`? This feeds the angle library's quality metadata.

   If yes, create `archived/YYMMDD/<slug>/postmortem.md`:
   ```markdown
   # Postmortem — <slug>

   ## Per-weakness scoring
   - <weakness 1>: valid | partial | hallucinated  (source angle: <angle>)
   - <weakness 2>: ...

   ## Per-angle precision (this paper)
   - novelty: 3/3 valid
   - methodology: 2/4 valid, 1 hallucinated
   - ...
   ```
   Aggregate per-angle precision into the library entry over time (add a `precision: N/M` line on the library entry, updated by the orchestrator).

6. Report to user: archive path, what was added to profile, what was added to angle library, postmortem scores if provided.

## Hard rule

Never modify `archived/YYMMDD/<slug>/` files after step 08 except for `postmortem.md`. The frozen snapshot is the source of truth.
