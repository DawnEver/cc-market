# Compress to the page limit

Write freely first: compress to the page limit only after the logic and data are final and the logic is approved;
a moderate overrun is accepted while drafting, because early compression breaks unfinished logic (user rulings
2026-11-08, 2026-11-09; user review 2026-11-23 P2-G7).

1. `academia-write page-budget`: pages against `document.page-limit` (and whether references count,
   `reference.inside-page-limit`).
2. Propose cuts as a list (location, old text, new text, lines saved, rule) ranked by lines saved per meaning lost:
   repetition of the abstract (structure.intro-no-abstract-repeat), restated cross-references
   (structure.one-place), background the argument does not use (argument.background-serves),
   then figure layout (figure.use-page-width) only with approval.
3. The abstract, introduction, conclusion and outline are never condensed without the author's approval
   (hard constraint 1). One item at a time where the author asks for it.
4. Apply approved cuts sentence by sentence (`revise.md`), then `review own`; report the new page count.
