# Author-biography PDF spike

Measured 2026-08-30 against the local database produced by the
`tte-2026-08-2905` run. This is a decision record for reviewer discovery, not a
new production parser.

## Question

Does fetching the final pages of public papers yield enough formulaic author
biographies to fill ranks that are currently `unknown`?

## Method

- Baseline: 1,187 stored papers; 599 had a `pdf_url`.
- Deterministic, host-stratified sampling was used so a large publisher could
  not dominate the result.
- 144 URLs were attempted and 65 actual PDFs were fetched and parsed, exceeding
  the plan's minimum sample of 60.
- The final three pages were checked for formulaic degree and current-position
  sentence shapes. Candidate yield required both authorship of that paper and
  an unknown stored rank; a biography-like sentence alone did not count.
- No manuscript PDF, abstract, or body was used. Only public-paper URLs already
  present in the scholarly store were fetched.

## Result

| Measure | Count |
|---|---:|
| URL attempts | 144 |
| PDFs fetched and parsed | 65 |
| PDFs with a formulaic, parseable biography | 11 |
| unknown-rank candidates filled | **0** |

The sample was broad: the 65 PDFs came from 53 hosts. There were 64 request
errors and 15 responses that were not PDFs, which also confirms that a stored
`pdf_url` is not equivalent to a fetchable PDF.

## Decision

Yield is below the plan's `< 5` stopping threshold. Do not build the biography
parser. Remove `PDF_BACK_PAGES` and stop rendering back pages in the automatic
contact path; retain first-page parsing because corresponding-author footnotes
do produce addresses. Manual lookup may still use a published biography and
return its URL as sourced rank or doctorate evidence.
