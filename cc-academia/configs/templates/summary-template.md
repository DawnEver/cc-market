# Summary template

This file is the consensus that every reviewer agent reads **first**, before forming an opinion. Stay factual. **No critique here** — disagreement and 锐评 belong in step 04, not in the summary.

If a field cannot be filled from the paper, write `Not stated in paper.` Never fabricate.

## Title
The exact paper title.

## Venue / Year
Venue (conference / journal / arXiv-only) and year, if extractable from the front matter.

## Venue type
`conference` or `journal` (or `unclear (assumed journal)`), plus **domain** (e.g. power electronics, electric machines, control, ML). This calibrates the `Obvious gaps` section and downstream reviewers — for electrical-engineering **conference** papers, simulation-only validation and no public code/data are normal and must NOT be listed as gaps.

## Problem
One sentence: what problem does the paper address, in plain terms?

## Claimed contribution
The contributions as the authors frame them. Bullet list, verbatim or near-verbatim from the abstract / introduction.

## Method
One paragraph in plain English. No equations. What does the method actually do, end-to-end?

## Key experiments and headline numbers
What was tested, on what, and what number is reported. Include the single most-cited result from the abstract.

## Datasets and benchmarks
Which datasets / benchmarks used. Splits, sizes, any notable preprocessing.

## Baselines
Which prior methods the paper compares against.

## Limitations admitted by authors
Verbatim or near-verbatim from the paper's limitations / discussion / conclusion. If none stated, write `Not stated in paper.`

## Obvious gaps
Objectively observable absences — facts, not judgements. **Calibrate to venue type**: for electrical-engineering conference papers, do NOT flag missing hardware experiments, public code, or public data — these are not expected at that venue. For journal papers (esp. IEEE Transactions), experimental/hardware validation is typically expected, so its absence is a legitimate gap. Examples:
- "All numbers reported at a single operating point / single seed; no variance or sweep."
- "No ablation isolating the contribution claimed in §1 bullet 2."
- "Figure 4 caption claims robustness but no robustness benchmark is reported."
- (journal only) "No experimental / hardware validation; simulation-only."

5–10 bullets max. If the paper really is thorough, write `None observed.` Downstream reviewers may pick these up — they are fact-finding, not 锐评.
