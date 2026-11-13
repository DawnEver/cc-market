# Paper Card Template — <ShortRef>

> Usage: copy this file to `<shortref>_card.md` (for the shortref see `papers_registry.md`) and fill in every section.
> Rule: filename = `<author-lastname>-<year>_card.md` (with several authors take the first, e.g. zhuang-2026); the body uses only title + authors, never the hash.

- **ShortRef**: `<AuthorLastname> et al. <year>` (e.g. Zhuang et al. 2026)
- **candidate_id** (internal only, never in the narrative): `S2-<hash>`
- **Title**: <full title>
- **Authors**: <author list>
- **Year / Venue**: <year> / <venue>

---

## One sentence

<One sentence: what is this paper's core contribution?>

## Verdict & confidence

- **verdict**: `include | targeted-read | background`
- **confidence**: 0.0–1.0

## Technical core

- <core contribution 1>
- <core contribution 2>
- <key points of method/experiments>

## Evidence

- {claim: "<claim made in the paper>", locator: "<section/figure/table>"}
- {claim: "...", locator: "..."}

## Limitations

- <limitation 1>
- <limitation 2>

## Research use (relative to the current review topic)

- {type: `mechanism | method | context | gap`, note: "<relation to this review's argument>"}
- {type: ..., note: "..."}

## Next action

<how this paper is used next -- implement it, compare against it, or cite it as evidence>

## Open questions

- <unresolved questions>
- <...>
