# Step 06 — User draft ⭐ (hard gate + session boundary)

Generate a **complete first draft** of the reviewer response from the user's selected critiques, in the user's natural reviewer voice. The user then edits this draft — adjusting wording, adding or dropping points, reordering — then re-invokes `/manuscript-review:new <slug>` to resume from step 07.

## Inputs
- `ongoing/<slug>/2-review/critiques.md`
- `ongoing/<slug>/review-config.md` — `lang:` (default `en`); write `draft.md` in this language. Note: `final.md` (step 07) is always plain-text English — if the draft is in Chinese, the polisher renders the English version from it.
- `templates/reviewer-voice.md` — house style profile
- `style/profile.md` — if it exists, accumulated voice from past reviews
- User's selection codes (e.g. `N1 M1 E2 F1`) — parsed from the user's response to step 05

## Output
- `ongoing/<slug>/3-response/draft.md` — complete first draft, ready for user editing

## What the orchestrator does

1. **Parse the user's selection codes.**
   - `N1 M3 E2` → include only those specific points.
   - `all N` → include all non-skip N-prefixed points. `all M` → all non-skip M-prefixed points.
   - `all` → include every non-skip point from `critiques.md`.
   - `⏭ SKIP` codes (e.g. `N4 ⏭ SKIP`) are never valid selections — they are auto-excluded.
   - Codes without a number (e.g. `N`) are invalid unless prefixed with `all` — ask to clarify.

2. **Read `templates/reviewer-voice.md`**. If `style/profile.md` exists, read that too — it may contain the user's accumulated voice from past reviews.

3. **Write `ongoing/<slug>/3-response/draft.md`** as a COMPLETE reviewer response in the user's voice:
   - **Opening**: A brief framing paragraph (1-2 sentences) that orients the reader — what the paper does, what this review focuses on. Vary the opening style naturally; don't use the same template every time. Sometimes "General Comments:", sometimes "The main contribution is...", sometimes jump straight to numbered points with "Below are the detailed comments."
   - **Numbered points**: Every critique is a numbered item. 2-5 sentences each. Self-contained — readable in isolation. Ordered from most to least important (severity conveyed by position, not labels). Every point is **actionable** — the authors know what to DO after reading it.
   - **Typos**: If any, as the last numbered point(s). Specific: "Page X: 'wrong' → 'correct'."
   - **Recommendation**: Final line. One of Accept / Minor Revision / Major Revision / Reject. No explanation needed on this line — the points above are the explanation.
   - **No `[Your comment here.]` placeholders.** The draft is complete prose. The user edits it, not fills it in.

   Style rules (from `templates/reviewer-voice.md`):
   - Direct address: "The authors should...", "Please provide...", "I suggest..."
   - Active voice. No academic hedging ("It could be argued that...").
   - No severity labels (don't prefix with "Major:" or "Minor:").
   - No internal pipeline references (no "angle N", "cross-angle corroboration").
   - Evidence woven in naturally ("Table 2 shows 69.3% vs 70.6%..." not a separate Evidence: bullet).
   - Occasional first-person (1-2× max) for humanity.

   - **Image-verify flags (`🔍 VERIFY`)**: do NOT bake figure-rendering critiques into the published review prose as firm defects. Instead, after the draft, list them separately for the user under a `── Verify these figures before sending ──` heading, each with its **image path** and a one-line note (e.g. "Figure 3 text looks unreadable — but this may be an extraction artifact; open `img/sec3/figure3.png` and confirm against the PDF before keeping this point"). The user decides whether the issue is real and whether it belongs in the review.

4. Tell the user, plainly:
   - Complete draft written to `ongoing/<slug>/3-response/draft.md` — edit freely: change wording, add or drop points, reorder.
   - Any `🔍 VERIFY` figure flags are listed separately with their image paths — check these against the original PDF before keeping them.
   - When ready, re-invoke `/manuscript-review:new <slug>` to resume at step 07 (polish).
5. **Stop.** Do not poll. Do not loop. End the turn.

## What happens on resume

When the user re-invokes with the slug:
- SKILL.md's resume table sees `draft.md` non-empty → enters step 07.
- Step 07 reads `draft.md` and runs the polisher.

## Hard rules

- The draft is COMPLETE prose, not a skeleton with placeholders. The user edits a finished text.
- The orchestrator never invents new technical claims beyond what is in `critiques.md`.
- The user owns editorial judgement — what to soften, elaborate, or drop.
- The polisher (step 07) polishes language, not content.
