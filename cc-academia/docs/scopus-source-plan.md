# Adding Scopus: journal counts and author position

Written 2026-10-06 from a live bibliometric study — 9 research groups, 1139
doctoral graduates, ~3300 API requests — so that an agent who has not seen that
session can execute or audit it. Each item states what it is, why, and the
evidence that settles it.

## Why

The plugin could say how many papers a person had published in a year (OpenAlex
`works_by_year`) but not **where they sat on them**. "First-author papers" is
the figure the study turned on, and no source here reports it: OpenAlex labels
`first`/`middle`/`last` but its `corresponding_author_ids` was empty across every
sampled work, and IEEE returns an author list without positions.

Scopus states it exactly. `view=COMPLETE` returns each document's **ordered**
author list, every slot carrying an `authid` and a 1-based `@seq`. Position is
then read off the record rather than inferred from a label that may be missing.

The second problem was identity. The study had to attach a publication record to
a person a *thesis record* names, and a thesis record offers a name, a year and a
supervisor — no ORCID. `AGENTS.md` bans name matching as an identity mechanism,
and that ban is right. What this change adds is the distinction that keeps it
right: a name may **propose** a persistent id; only stated corroboration
**admits** it.

## Invariants

1. Identity is an id, never a name. A name is a search key. This is unchanged.
2. A proposal is admitted only on corroboration the *record* supplies — a
   document shared with a named supervisor.
3. A tie is refused, not ranked. `admit_candidate` returns `None` for "several
   supported equally" as well as for "none proposed", and the caller must tell
   those apart in what it reports.
4. Corroboration is tested on every document type; the *count* is journal
   articles and reviews only. A graduate whose only output is a conference paper
   is still that person, and counts as zero journal articles — dropping them
   biases the average downwards.
5. Anything in the portable fact set must be a stated fact with a source, and
   merging it must be idempotent.
6. No test opens a socket. External responses come from `tests/fixtures/`.

## Items

### 1. `sources/scopus.py` — the client

`_headers()` reads `SCOPUS_API_KEY` and an optional `SCOPUS_INST_TOKEN` at call
time; transport goes through `core/http.get_json`, so `SourceError`,
`with_retries` and the `no_network` guard all apply unchanged. `to_paper`,
`to_person`, `author_position`, `is_journal_article`, and a `Scopus` class
implementing `PaperSource` and `AuthorSource`.

**Acceptance**: `to_paper` on a `COMPLETE` search result yields authors whose
positions are `first`…`last` in list order; `author_position` returns `""` for
someone not on the document and for a document listing no authors;
`is_journal_article` separates an article from a conference paper.

**Evidence**: `tests/test_sources_scopus.py`, fixture
`tests/fixtures/scopus_documents.json`.

### 2. The four API traps, encoded

Each cost live debugging and each fails silently or misleadingly:

| Trap | What happens if unhandled |
|---|---|
| `AUTHLAST()` is author-search only | 400 `Error translating query` in a document search |
| two bare `AUTH()` terms ANDed | returns **unrelated** documents: `AUTH(kumar) AND AUTH(clare)` answered with *Genome Biology* |
| one result → object; zero results → one `error` entry | truthiness reads "no such person" as "found one" |
| page size 25 | 100 and 200 are rejected: `Exceeds the maximum number allowed for the service level` |

**Acceptance**: `_results` returns `(0, [])` for the error-entry payload and
normalises a single object to a one-item list; `coauthorship_query` builds
`AU-ID(x) AND AUTH(y)` and never two `AUTH()` terms.

**Evidence**: `tests/test_sources_scopus.py`; the `AUTH()` finding was observed
directly against the live API.

### 3. `core/text.py` — person names

`split_person_name`, `person_name_key`, `name_keys`. Repositories write "Zhu,
Zi-Qiang", "ZHU Z.Q." and "Donoso Merlet, Felipe Octavio" for the same kinds of
thing.

**Acceptance**: every spelling of one name folds to one key; a two-word surname
survives; `person_name_key` does not re-split a surname a source already gave;
`name_keys` returns two readings only when no comma settles the order.

**Evidence**: `tests/test_core_text.py`. The multi-word surname is not
hypothetical — re-splitting `surname="Donoso Merlet"` is what lost a live match.

### 4. `scopus_id` as an identity

Column on `persons` + partial unique index (mirroring `ieee_author_id`), a rung
in `_resolution_for` at 0.85, an entry in `_find_person_id`'s precedence, and an
entry in `db._ADDED_COLUMNS` so an existing store gains the column rather than
being rebuilt.

**Acceptance**: a store written before this change opens and accepts a
`scopus_id`; two people cannot claim one profile (the unique index).

### 5. `profiles`, a sixth portable fact

A person→profile mapping somebody confirmed, plus `person_profiles` recording
who stated it and where. Only stated ones travel: a matched profile comes back
by re-running the match. `_resolve_person` now accepts a stated profile id as
identification — the store that needs the correction is by definition the one
whose search failed, so it may hold no person row and no ORCID.

**Acceptance**: a matched `scopus_id` does not appear in the export while a
stated one does; a correction imported into a fresh store attaches to the right
person; a profile naming a system the store cannot apply is skipped, not stored.

**Evidence**: `tests/test_facts.py`.

### 6. Wiring

`SCOPUS_API_KEY` in `.env.template`; `scopus_api_key` in `academia doctor`;
Scopus in the source-hierarchy table of `AGENTS.md`; the identity distinction
written up under "Identity — never by name".

## Out of scope

The cohort layer — building a roster from thesis repositories, windowing
articles around a graduation year, and the trend figures — is developed
separately. It is why this change stops at a source and an identity rule: the
plugin carries generic capability, and a study is built on top of it.

## Gates

`ruff check .`, `pytest -q` (no network), `python scripts/release.py --check`.
