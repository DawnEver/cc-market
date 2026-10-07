# Scopus source — completion audit

Written 2026-10-06 against the source tree, the offline test suite, and a live
re-run of the bibliometric pipeline that motivated the change.

| Plan item | Result | Authoritative evidence |
|---|---|---|
| 1. `sources/scopus.py` client | complete | `tests/test_sources_scopus.py`; the live run below issued ~3300 requests through it |
| 2. The four API traps encoded | complete | `test_a_search_finding_nothing_is_not_read_as_one_result`, `test_a_single_result_arrives_as_an_object_and_is_normalised_to_a_list`, `test_coauthorship_query_pairs_an_id_with_a_name_and_never_two_names`; the `AUTHLAST` 400 was observed live |
| 3. `core/text.py` name functions | complete | `tests/test_core_text.py` (32 tests), including the two-word-surname case that lost a live match |
| 4. `scopus_id` as an identity | complete | `schema.sql` column + partial unique index; `repository._find_person_id`, `_resolution_for`; `db._ADDED_COLUMNS["persons"]` |
| 5. `profiles`, sixth portable fact | complete | `tests/test_facts.py`; a matched id stays out of the export while a stated one travels |
| 6. Wiring | complete | `.env.template`, `cli/doctor.py`, `AGENTS.md` |
| Project scripts rewired onto the plugin | complete | `scripts/bridge.py` and `scripts/scopus_api.py` deleted; the DSpace and EPrints fetchers verified live through `core.http` (333 items, 48 thesis links) |

## Gates

- `ruff check src tests scripts` — clean.
- `pytest` — 641 passed, 4 skipped. No test opens a socket.
- `python scripts/release.py --check` — all manifests at 0.1.20.

## Live end-to-end evidence

The six source tests prove the client; they do not prove the study. The whole
pipeline was re-run against the rewired scripts with the data already on disk,
so no re-harvest was needed:

| Group | Graduates | Matched | PhD+2 ρ (all / first / co) |
|---|---|---|---|
| Home lab | 201 | 151 | +0.25 / +0.22 / +0.21 |
| Sheffield EMD | 199 | 66 | −0.06 / −0.05 / −0.01 |
| Virginia Tech CPES | 130 | 74 | +0.15 / +0.17 / +0.07 |
| Aalborg AAU Energy | 218 | 114 | +0.04 / +0.16 / −0.05 |

The home lab is unchanged on every figure from before the move. The conclusion the study
exists to test — that the home lab's per-graduate journal output has *not* fallen, in the
aggregate or in the first-author subset — is unaffected.

## Deviations from the plan, recorded

**1. One number moved, and the move is a fix.** The plan's acceptance criterion
was "the published numbers are unchanged". Seven of nine groups are identical;
**Sheffield EMD is 198 → 199 graduates.**

Cause: `roster.py` deduped people on a *sorted-token* name key
(`" ".join(sorted(tokens))`), replaced by the plugin's `normalize_name`. Sorting
tokens destroys the one distinction a personal name carries — which word is the
surname — so the old key merged people who are not the same person:

| Kept now | Was merged with | Why the old key collided |
|---|---|---|
| `Zheng, Hui` (surname Zheng) | `Hui, Zheng` (surname Hui) | both sort to `hui zheng` |
| `Li, Yang` (surname Li) | `Yang, Li` (surname Yang) | both sort to `li yang` |

The new key gives `zheng hui` and `hui zheng`, which differ. Sheffield EMD gains
`Li, Yang` (2026). The remaining 6 de-duplications are genuine same-name pairs,
checked one by one — `Cao, Shengyu`, `WU, DI`/`Wu, Di`, `Gao, Yuan`,
`Wang, Chao`, `Li, Wei`, `Jin, Xiao` — including one cross-institution collision
(`Wang, Chao` at Sheffield EMD against Aalborg) which the rule resolves by
dropping, as it always has.

So the criterion is met in spirit and not in letter, and the letter moved in the
study's favour: a person who was being counted as someone else now is not.

**2. Scope note.** The plan listed HTTP plumbing as part of the project-side
rewiring. It is done — `roster.py` now fetches through `core.http.get_json` /
`get_text` — but the repository parsers themselves (`uon()`, `shef()`, and the
cached harvests) stay project-side. They move with the cohort layer, where they
can be rewritten against recorded fixtures instead of being changed untested
over a live network.
