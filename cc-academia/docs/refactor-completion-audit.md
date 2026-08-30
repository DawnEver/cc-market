# Reviewer-discovery refactor completion audit

Audited 2026-08-30 against `docs/refactor-plan.md`, the current source tree,
the complete offline test suite, and a live downstream rerun of the sanitized
`tte-2026-08-2905` workspace. No raw submission PDF was opened.

## Requirements and evidence

| Plan item | Result | Authoritative evidence |
|---|---|---|
| 0.1 UTF-8 CLI streams | complete | `cli/dispatch.py` reconfigures stdout and stderr; `test_cli_encoding.py` plus the non-ASCII contacts/report end-to-end test. A live subprocess forced cp1252 before entry, had `PYTHONIOENCODING` unset, and returned valid UTF-8 JSON containing non-ASCII names with exit 0. |
| 0.2 lookup completion state | complete | `reviewer/lookups.py`; `4-audit/lookups.jsonl`; per-person `searched`/`last_outcome`; `missing`/`resolved`/`never_searched`; persistent `5-shortlist/lookup-coverage.json`; 2-of-5 acceptance test. |
| 1 biography spike | complete | `author-biography-spike.md`: 144 attempted URLs, 65 fetched PDFs, 11 formulaic biographies, zero unknown-rank candidate yield. This selects the plan's `<5` branch. |
| 2.1 biography parser | correctly not built | The measured gate rejected it. `PDF_BACK_PAGES` and automatic back-page rendering were removed; first-page address extraction remains. |
| 2.2 source wiring and observability | complete | Semantic Scholar is in the default registry; unknown sources raise `UsageError`; every search writes `per_source`. `ieee-recall-diagnosis.md` records the query-shape diagnosis and source-specific fix. |
| 2.3 address recency | complete without precedence reversal | Every address is embedded in `shortlist.csv`'s `emails_json`; `email_affiliation_domain` is a conservative match/mismatch/unknown signal. It never reorders an address. |
| 3 retrieval configuration | complete | `[retrieval]` in `coi.toml` uses the existing recursive journal overlay. Candidate breadth, publication budget, PDF pages, page delay/size/failure budget, confidence, and precedence are configurable; CLI breadth flags remain explicit overrides; missing override keys fall back. |
| 4 responsibility cleanup | complete | Public-page/PDF address extraction remains in `contact.py`; agent-owned worklists, answers, and attempt state moved to `lookups.py`. User-facing CSV output is consolidated into one comprehensive shortlist and one minimal contact list. |

## Live rerun evidence

The downstream pipeline was rerun from the sanitized profile through search,
candidates, enrichment, COI, and report on the current machine:

- OpenAlex: 1,127 unique returned papers before cross-source de-duplication.
- IEEE: 405, compared with 62 in the pre-refactor run. This verifies the query
  adaptation fix against the real endpoint rather than only a fixture.
- Semantic Scholar: zero, with five explicit HTTP 429 failures because this
  machine has no API key. The collapse is visible in both `per_source` and
  `failures`.
- 1,517 unique papers stored, 160 candidates built and enriched, 156 `CLEAR`
  and 4 `BLOCK` COI verdicts, and a complete report written.
- Lookup coverage reports 145 missing, 15 resolved, and 145 never searched;
  the report therefore warns that reachability coverage is not final.

## Gates

Before each numbered commit and after sharp review fixes:

```text
ruff check .                         passed
python scripts/release.py --check   passed; all manifests at 0.1.14
pytest -q                            passed (network disabled; optional-extra skips only)
```

Sharp review found two medium defects: IEEE negation adaptation and incomplete
email-precedence overlays. Both have regression tests, are fixed, and are marked
`FIXED` as `SR-20260830-030` and `SR-20260830-031`.

## Invariants

Candidate creation still starts exclusively from authorships of related papers;
no address is generated; COI remains deterministic; sourced facts retain their
URLs; unknown evidence stays neutral; manual lookup accepts URLs rather than
addresses; and report wording remains **no detected conflict**.
