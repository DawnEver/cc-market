---
name: scopus-author-position-and-identity-by-proposal
description: Scopus added as a source for ordered author lists; a name may propose a persistent id but only stated corroboration may admit it, and the four API traps that fail silently
metadata:
  type: engineering
---

# Scopus: author position, and a name that may only propose an id

Commit: `feat: add Scopus as a source, with corroborated profile matching`
(`cc-market` `4630b60`)

No source here stated **author position**. OpenAlex labels `first`/`middle`/`last`
but its `corresponding_author_ids` was empty across every work sampled; IEEE
returns an author list without positions. Scopus returns the **ordered** author
list under `view=COMPLETE`, each slot carrying `authid` and a 1-based `@seq`, so
"first-author papers" becomes a count rather than an estimate.

## The four traps, all silent

Each cost live debugging. They are in the module docstring because none of them
announces itself:

- **`AUTHLAST()` is an author-search field.** In a *document* search it is a 400
  `Error translating query`. Document search spells it `AUTH()`.
- **Two bare `AUTH()` terms ANDed do not intersect.** `AUTH(kumar) AND
  AUTH(clare)` answered with *Genome Biology* and *Physical Review Letters* —
  documents containing neither name. Only `AU-ID(<id>) AND AUTH(<name>)` is
  dependable, and it is the only conjunction the module builds.
- **A search has three response shapes.** One result arrives as an object where
  a list is expected; **zero results arrive as a single entry carrying
  `error`**, not an empty list. Code testing truthiness reads "no such person"
  as "found one" — which is exactly how a matching pass discarded the matches it
  was looking for.
- **Page size is 25.** 100 and 200 are rejected: `Exceeds the maximum number
  allowed for the service level`.

Also: `opensearch:totalResults` is a **string** and needs `int()`.

## Identity: propose versus admit

Attaching a publication record to a person a *thesis record* names needed a
distinction the house rule did not yet spell out. The rule ("name matching is
banned as an identity mechanism") is unchanged; what is now written down is the
two-step:

- A **name proposes** candidate author ids. It is a search key.
- **Acceptance requires stated corroboration** — a document shared with someone
  the *record* names, such as a doctoral supervisor. This is tested on every
  document type, because a graduate whose only output is a conference paper is
  still that person and counts as **zero journal articles**; dropping them
  biases the average downwards.
- **A tie is refused, not ranked.** `admit_candidate` returns `None` for
  "several supported equally" as well as for "none proposed", deliberately, and
  the caller must tell those apart in what it reports. Guessing attaches one
  person's record to another, and a missing count is recoverable in a way a
  wrong one is not.
- An uncorroborated profile enters at the `name_only` rung (0.3), so nothing on
  this path can mint identity from a name. `to_person(..., corroborated=True)`
  is what raises it to the `scopus_id` rung (0.85, alongside `ieee_author_id`).

`scopus_id` is a `persons` column with the usual partial unique index, added
through `db._ADDED_COLUMNS` so an existing store gains it rather than being
rebuilt — `persons` holds facts a person paid to establish.

## Candidate enumeration is the hard half, and ranking by output is wrong

The author search ranks by document count, so **a recent graduate never reaches
the first page of a common surname** — `AUTHLAST("kumar") AND AUTHFIRST("dinesh")`
returns 900 profiles and the right one is not among the first 25. An affiliation
filter (`AFFIL`) narrows it to one when it works, but it matches the author's
*current* affiliation, so anyone who has moved is lost; the ladder therefore
widens in stages — with affiliation, then without, then without the given name —
cheapest and most precise first.

`AUTHFIRST` matches a **single** given name. Handing it `"alex taiwo"` returns
nothing at all rather than a superset, so only the first token is sent.

## Deliberately not done

- **Not in `SOURCE_NAMES`.** Scopus needs a key, answers from a weekly quota, and
  carries neither abstracts nor index terms, so a default multi-source run must
  not drift into it. `SOURCE_NAMES` is now an explicit comprehension excluding
  it, with the reason in a comment; a caller that wants Scopus names it.
- **`Person.works_by_year` stays empty** for a Scopus profile.
  `coredata.document-count` is one career total, and a total is not a series;
  filling it would put a number in a per-year field and every later sum would be
  wrong.
- **No per-author affiliation.** The web API does not carry one. Left empty
  rather than guessed; affiliations come from OpenAlex.

## Files

- `src/academia/sources/scopus.py` (new), `sources/__init__.py`
- `src/academia/core/text.py`, `core/models.py`
- `src/academia/store/{schema.sql,db.py,repository.py,facts.py}`
- `src/academia/cli/doctor.py`, `.env.template`, `AGENTS.md`
- `tests/test_sources_scopus.py` (new), `test_core_text.py`, `test_facts.py`,
  `tests/fixtures/scopus_{documents,authors,author}.json`
- `docs/scopus-source-plan.md`, `docs/scopus-source-completion-audit.md`
