# Polish checklist — English reviewer comments

## CRITICAL: output format

The polished `final.md` is **plain text**. It will be pasted directly into a conference review form (OpenReview, CMT, HotCRP). Strip every piece of markdown syntax — including any that leaked in from `draft.md`.

Hard rules for the output:
- No `#`, `##`, `###` headings. Section labels are plain words on their own line.
- No `-`, `*`, `+` bullets. Prefer prose paragraphs. If a list is genuinely numbered, use `1.` `2.` `3.` inline.
- No backticks, no fenced code blocks. If you must quote a symbol, write it inline (e.g. write lambda, not `λ` in code font).
- No bold, italic, underline, or any other inline formatting markers.
- No emoji.
- Blank line between sections. Single newline between paragraphs within a section.

Strip these silently — the user will not see your reasoning, only the file.

## Structure

Follow the structure in `templates/reviewer-voice.md`:
- Opening paragraph (1-2 sentences framing the paper and review focus).
- Numbered points, most important first. Each 2-5 sentences, self-contained, actionable.
- Typos (if any) as the last numbered point(s).
- Recommendation as final line.

If the draft uses a different structure, preserve it. Don't force a restructure.

## Tone

- Constructive. The goal is to help the authors improve the paper.
- Direct address is fine: "The authors should...", "Please provide...", "I suggest..." — per `templates/reviewer-voice.md`.
- Occasional first-person ("I have concerns about...") is allowed, 1-2× max. Don't strip it if the draft uses it. Don't add it if the draft doesn't.
- No academic hedging: avoid "It could be argued that...", "One might consider...". Say it straight.
- Active voice. No severity labels (Major/Minor) — point order conveys importance.

## Language

- Active voice throughout.
- Prefer concrete claims with locations ("Section 3.2 states...", "Table 4 reports...") over vague critique.
- British or American English — match whichever the draft uses; if mixed, default to American.
- No imperatives directed at the authors. Prefer "the authors should included X" or "please provide Y" over "include X".

## Evidence

- Every substantive claim in `final.md` must trace back to a line in `draft.md`. No fabrication.
- The polisher may reorganise, soften, sharpen, rephrase, merge duplicates, and split overloaded sentences.
- The polisher may **not** introduce new technical claims, citations, numbers, or named methods that are not already in `draft.md`.
- If `draft.md` cites a paper or number without source, keep it as-is; do not invent a citation.

## Final pass

Before writing the file:
1. Re-read each section. Strip any markdown that survived.
2. Confirm every paragraph could be defended from a sentence in `draft.md`.
3. Confirm the structure matches the draft (numbered points or section labels — don't force a restructure).
4. Confirm first-person "I" appears at most 1-2×, and only if the draft uses it.
