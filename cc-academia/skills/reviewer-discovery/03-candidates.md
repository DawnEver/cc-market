# 03 — Candidates

Score the papers, then take the people who wrote the best ones.

```bash
uv run --project "<plugin-root>" rev-disc candidates --slug <slug> \
  --min-evidence 1 --json
```

`candidate_pool` and `top_papers` default from `[retrieval]` in `coi.toml` and
may be overridden per journal. `--pool` and `--top-papers` remain explicit
one-run overrides.

## How relevance is scored

```
0.30  BM25 over title and abstract
0.20  controlled-term overlap (OpenAlex keywords and topics)
0.10  recency
0.40  embedding similarity   # only when a backend is configured; otherwise the
                             # remaining weights renormalise rather than the
                             # scores silently dropping
```

## How authors are weighted

Every author of a relevant paper is a candidate, weighted by position:

| Position | Weight |
|----------|--------|
| first | 1.0 |
| corresponding | 1.0 |
| second | 0.8 |
| last | 0.8 |
| other | 0.4 |

Deliberately not restricted to first and second authors: fields differ over
whether the group leader signs first or last, and a hard rule would
systematically miss senior reviewers in half of them.

## Identity

Candidates are resolved in strict order — ORCID, then the OpenAlex id, then the
IEEE author id, then Semantic Scholar. **Names never merge identities.**

In this field roughly nine in ten authors carry an ORCID, so most candidates
resolve confidently. The rest are flagged: the command warns how many were
resolved by name alone, and the report marks them "confirm before inviting".

Take that seriously. An unconfirmed identity means the institution, the career
history and the conflict check may all belong to a different person.

## Tuning

- `--min-evidence 2` when the pool is large: requiring two relevant papers drops
  incidental co-authors.
- `--top-papers` sets how deep into the ranking authors are harvested.
- `--pool` sets how many stored papers are scored at all.

`top_papers` is not a target candidate count: co-author density makes the
mapping nonlinear. The measured TTE run produced `50→21`, `100→44`, `110→50`,
`200→109`, and `400→225` candidates. Change it deliberately and inspect the
reported candidate count rather than assuming a fixed ratio.
