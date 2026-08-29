# 02 — Search

Run every query against every source, merge, and store.

```bash
uv run --project "<plugin-root>" rev-disc search --slug <slug> \
  --source openalex --source ieee --pages 3 --year-from 2018 --json
```

## Choosing sources

| Source | Contributes | Note |
|--------|-------------|------|
| `openalex` | institutions with country codes, keywords, reference lists | primary; CC0, so it may be cached |
| `ieee` | best relevance for IEEE venues, persistent author ids | no affiliations, no index terms |
| `semantic_scholar` | open-access links | needs `S2_API_KEY` to be useful |
| `arxiv` | preprints | most reliable open PDF links |
| `dblp` | CS venue coverage | metadata only |

Default to `openalex` plus `ieee`. Add `arxiv` in fast-moving areas where the
relevant work may not be published yet.

A source that fails is recorded and skipped rather than fatal — losing IEEE must
not abort a run that OpenAlex can still serve. Check `failures` in the JSON and
tell the user which sources actually contributed.

## Judging the result

Aim for **at least 100** unique papers before harvesting authors. Fewer than that
and the candidate pool is thin enough that the ranking becomes arbitrary.

If the count is low:

1. widen `--year-from`
2. drop the narrowest query
3. add a source
4. go back to `01-intake.md` and rework the queries — usually the real fix

If the count is enormous (say over 2000) the queries are too broad. Relevance
scoring will still rank them, but the author pool gets noisy. Tighten first.

## What is stored

Papers, authors and the co-authorship graph go into the shared database, so a
second manuscript in the same field starts with much of this work already done.

From IEEE only derived results are persisted — identifiers and scores, never a
bulk copy of its metadata.
