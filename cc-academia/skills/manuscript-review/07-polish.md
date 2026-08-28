# Step 07 — Polish draft → final.md

Spawn `manuscript-polisher-english` to refine the user's edited draft into publishable reviewer English while preserving the user's natural voice.

## Inputs
- `ongoing/<slug>/3-response/draft.md`
- `templates/reviewer-voice.md` — house style
- `style/profile.md` (if it exists — accumulated voice)
- `templates/polish-checklist.md`

## Output
- `ongoing/<slug>/3-response/final.md`

## Steps

1. `Agent(subagent_type: polisher-english)` with a prompt containing:
   - Full paths to `draft.md`, `templates/reviewer-voice.md`, `style/profile.md`, `templates/polish-checklist.md`.
   - Output path `ongoing/<slug>/3-response/final.md`.
   - **Output language: English**, regardless of the draft's language. If `draft.md` is in Chinese (per `review-config.md`), translate it into natural reviewer English — preserve content faithfully, invent nothing.
   - **Output format: plain text only.** No markdown headings, no bullets with `-` or `*`, no backticks, no bold/italic. Numbered points use `1.` `2.` plain text. Recommendation is a standalone final line.
   - **Structure** (from `templates/reviewer-voice.md`):
     - Opening paragraph (1-2 sentences framing the paper and review focus). Vary naturally — don't reuse the same opener.
     - Numbered points, most important first. Each 2-5 sentences, self-contained, actionable.
     - Typos (if any) as the last numbered point(s).
     - Recommendation as final line.
   - **Voice rules** (from `templates/reviewer-voice.md`):
     - Direct address: "The authors should...", "Please provide...", "I suggest..."
     - Active voice. No academic hedging.
     - No severity labels (Major/Minor). Order conveys importance.
     - No internal pipeline references — the review stands alone.
     - Occasional first-person for humanity (1-2× max).
   - **Hard rules**:
     - Every substantive claim in `final.md` must trace to a line in `draft.md`. The polisher may reorganise, soften, sharpen, or rephrase — but never invent new technical claims.
     - Don't over-formalise. The user's draft has a human voice — keep it. If the draft says "you need to show the mesh convergence," don't rewrite it as "it is recommended that mesh convergence be demonstrated."
     - Strip any markdown syntax that slipped in from the draft.
2. Show `final.md` to the user. Iterate on tone/length if requested.
3. When the user approves, proceed to step 08.

## Host adaptation

- **Claude Code:** use `Agent(subagent_type: polisher-english)` as above.
- **Codex:** read `.claude/agents/manuscript-polisher-english.md` in full, then spawn one bounded collaboration subagent with that canonical prompt plus the paths and constraints above. If collaboration agents are unavailable, the current model may execute the same prompt locally as an explicit same-model fallback. Enforce traceability/no-invention and verify `final.md` exists and is non-empty.
