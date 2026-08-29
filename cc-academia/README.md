# cc-academia

Academic research toolchain for Claude Code and Codex: systematic literature
review, manuscript peer review, and reviewer discovery for a journal editor.

Three skill workflows over one deterministic Python library and one accumulating
local database.

## Install

```
/plugin marketplace add DawnEver/cc-market
/plugin install cc-academia@cc-market
```

## Workflows

| Command | What it does |
|---------|--------------|
| `/cc-academia:literature-review <topic>` | Define scope, search across sources, screen abstracts, acquire PDFs, deep-read, synthesise, export, sync to Zotero |
| `/cc-academia:manuscript-review <pdf>` | Ingest a paper, profile its literature, fan out multi-angle critiques, polish reviewer comments |
| `/cc-academia:reviewer-discovery <pdf>` | Profile a submission, find authors of the closest work, screen conflicts, produce an evidenced shortlist |

## What makes the reviewer shortlist trustworthy

Candidates are discovered as authors of demonstrably related work, never by
asking a model for names. Conflicts of interest are decided by a rule engine, not
a model, and every verdict cites the rule and the evidence behind it. A conflict
removes a candidate rather than deducting points, so no amount of topical fit can
outweigh one. Contact addresses are found on public pages and recorded with their
source; none is ever generated from a name-and-domain pattern.

Geographic separation uses the candidate's current affiliation country. Nothing
is inferred from a name.

Each candidate's academic position is shown — professor, lecturer, postdoc, PhD
or MSc student — because a pool harvested from authorship contains students by
construction. A position is stated by a source or left unknown; students stay on
the list, flagged, rather than being dropped.

## Data sources

OpenAlex (primary — CC0, ROR-linked institutions, country codes, reference
lists), IEEE Xplore (relevance within IEEE venues), ORCID (education and
employment), Semantic Scholar (open-access links, needs a key), arXiv, DBLP.

IEEE data is used at query time only; nothing beyond identifiers and derived
scores is retained.

## Requirements

Python 3.12+ and [uv](https://docs.astral.sh/uv/). Optional extras cover PDF
handling, browser-based acquisition, plotting, Zotero and AI backends — each
command names the extra it needs.

## Development

See `AGENTS.md`. In short: keep the build environment off any synced folder via
`UV_PROJECT_ENVIRONMENT`, and run `uv run python -m pytest` — the suite never
touches the network.

MIT licensed.
