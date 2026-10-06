---
name: person-name-keys-and-the-dedupe-they-corrected
description: Why a sorted-token name key merges different people, and why a source that already separates the surname must not be re-split
metadata:
  type: engineering
---

# Two ways a person-name key goes wrong

Commit: `feat: add Scopus as a source, with corroborated profile matching`
(`cc-market` `4630b60`) — the helpers are in `core/text.py`; the second defect
below was in a study's own `roster.py`, found while rewiring it onto the plugin.

## A source that separates the surname must not be second-guessed

Scopus reports `surname="Donoso Merlet"`. Running that through the new
`split_person_name` finds no comma, takes the first token as the surname, and
turns the person into "Donoso" — so a profile that had already been identified
by id stopped matching its roster entry.

`person_name_key(surname, given)` therefore takes the surname **as given** and
never re-splits it. A two-word surname is one word to its owner and two to a
tokeniser, and the comma is what says so.

## Sorting the tokens destroys the only information a name carries

`split_person_name` handles the spellings the stores actually write — "Zhu,
Zi-Qiang", "ZHU Z.Q.", "Prof. Zhu, Zi-Qiang", "Al-Lehaby (Mohammed), Ibrahim".
A full stop becomes a space, which is what lets `ZHU Z.Q.` and `Zhu, Zi-Qiang`
fold to the same surname and the same given-name initial.

The trap is the *other* direction. A dedupe key built as
`" ".join(sorted(tokens(name)))` looks order-insensitive and safe, and it merges
people who are not the same person:

| Kept apart now | Merged before | Both sort to |
| --- | --- | --- |
| `Zheng, Hui` (surname Zheng) | `Hui, Zheng` (surname Hui) | `hui zheng` |
| `Li, Yang` (surname Li) | `Yang, Li` (surname Yang) | `li yang` |

Sorting discards the one distinction a personal name exists to carry — which
word is the surname. Swapping the study's sorted key for `normalize_name`
recovered two graduates who had been counted as somebody else.

## `name_keys` returns a set, on purpose

Without a comma the word order is genuinely undecidable: "Geraint Jewell" and
"Zhu Zi-Qiang" have one shape and opposite orders, and the repositories write
both. So the honest answer is *every* reading, and two names match when their
key sets intersect. `person_name_readings` gives the readings with the whole
given name, for callers comparing against given-name prefixes; `name_keys` keeps
only the initial.

One consequence to expect: `person_name_key("Wang", "Bo") ==
person_name_key("Wang", "Bei") == ("wang", "b")`. That is correct — the key is a
**filter**, never an identity, and evidence decides between them. A test that
asserts otherwise is testing the wrong contract.

## The portable fact a correction rides on

A profile somebody confirmed by hand enters the portable fact set as
`profiles`, with `person_profiles` recording *who* stated it and *where*. Only
stated ones travel: a matched profile comes back by re-running the match, so
exporting it would be exporting a cache. `persons.scopus_id` remains the
identifier every lookup reads; `_apply` writes both, because writing only the
provenance row produces a correction that is faithfully synced and never
applied.

`_resolve_person` now accepts a stated profile id as identification. Without
that the fact is dropped on arrival: the store that needs the correction is by
definition the one whose search failed, so it may hold no person row and no
ORCID to attach the fact to. The id is a persistent identifier and `person_id`
is derived from it, so this cannot land a fact on a namesake — which is the only
thing the original gate exists to prevent.

## Files

- `src/academia/core/text.py`, `core/models.py`
- `src/academia/store/{schema.sql,db.py,repository.py,facts.py}`
- `tests/test_core_text.py`, `tests/test_facts.py`
