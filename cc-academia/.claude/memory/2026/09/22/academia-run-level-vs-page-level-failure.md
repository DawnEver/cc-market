---
name: academia-run-level-vs-page-level-failure
description: A per-page "retry is worth it" verdict must never drive run-level control flow — 429 is transient for one page and a wall for a run
metadata:
  type: engineering
---

# Per-page retry policy is not run-level abort policy

Commit: `fix(academia): stop a spent API quota reading as an empty literature`

`cc-academia` had `is_transient()` answering "would retrying this help?" and
`with_retries` using it per page — correct. The mistake was letting that same
answer imply anything about what the *run* should do next. For a 429 the answers
diverge: retrying a page is reasonable, but a spent quota repeats for every
remaining query, so continuing just spends the budget whose loss it is
reporting.

## The change

- **`ACCOUNT_STATUSES`** in `core/http.py` — statuses describing the account
  rather than the request (401/402/403/429), plus **`error_status()`** as the one
  parser for a `SourceError`'s status. `is_transient` now calls it too, so there
  is a single place that reads `details["status"]`.
- **`Probe.failure_status: int | None`** and **`Probe.is_account_failure`** in
  `sources/base.py`. An int, not a vocabulary word: no taxonomy to maintain, and
  a caller can grep it out of an artifact. `in ACCOUNT_STATUSES` is False for
  `None`, which is what a transport failure should give.
- **`run_probe` aborts on an account failure** and writes the untouched queries
  as `status: "not_probed"` with the reason, rather than probing each of them
  into a wall. Exit code is `EXIT_SOURCE` (3), the documented code for "external
  source failure".
- **`failure_reasons(path)`** reads the reason back out of the probe/audit JSONL,
  so it outlives the process that discovered it. `workflow_search` uses it
  instead of substituting a generic `RuntimeError("one or more queries
  failed")` — which is what had been destroying the detail.
- A failed query now gets a row in `search_audit_<provider>.log`. It previously
  got none, so the file the error pointed at ("see audit log") was written
  **empty** when every query failed.

## Deliberately not done

`probe()` is still not wrapped in `with_retries`, and a comment says why. A
probe is one small page, and the failure it most often reports is a persistent
one — retrying it three times per query across a fifty-query plan spends the
budget it just ran out of. The next reader will otherwise "fix" this omission.

## Related, same commit

- **Constraint layering**: `query > queries.toml [constraints] > brief
  [constraints] > workspace.toml [defaults]`. The brief's table and the
  workspace's defaults were previously read by nothing at all. Precedence puts
  the layer inside the plan's own approval hash on top, since that is the one a
  user actually signed.
- **Provider-safe kwarg forwarding** via `inspect.signature(source.search)`,
  because forwarding `content_types` to the three sources that never declared it
  raised `TypeError` on every query carrying one — recorded as a query failure,
  which looks exactly like a query that matched nothing. A dropped option is
  printed once per provider and recorded per row; a filter believed applied and
  not applied is worse than no filter. The helper returns `None` for a source
  with `**kwargs` ("accepts anything"), which must not be confused with an empty
  frozenset ("accepts nothing").
- **`OPENALEX_API_KEY`** support. `_polite()` became `_identified()`, since it
  now carries a credential and not only the polite-pool contact.

## Files

- `src/academia/core/http.py`, `src/academia/sources/base.py`,
  `src/academia/sources/openalex.py`
- `src/academia/litreview/search.py`, `workflow_search.py`, `brief.py`,
  `query.py`
- `tests/litreview/test_probe_artifacts.py` (new), `test_query_kwargs.py` (new)
