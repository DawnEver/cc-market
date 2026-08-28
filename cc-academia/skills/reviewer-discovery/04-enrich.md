# 04 — Enrich

Fill in where each candidate works, how they got there, and how to reach them.

```bash
uv run --project "${CLAUDE_PLUGIN_ROOT}" rev-disc enrich --slug <slug> --limit 40 --json
```

Background and contact details are one step because they share a source. ORCID
carries an education section for only about 30% of researchers in this field —
measured on a live sample, not assumed — so an institutional page usually has to
be fetched anyway, and that single fetch yields both the address and the degree
history, backed by the same URL.

## What gets filled in

| Field | Source | Coverage |
|-------|--------|----------|
| Current institution and country | OpenAlex, ROR-linked | high |
| Career history with years | OpenAlex affiliation series | high |
| Degrees and alma mater | ORCID education | around 30% |
| Doctoral supervisor | direct textual evidence only | low |
| Public email | published corresponding address > institutional page > lab page > public ORCID | varies |

## Rules that are not negotiable

- **No address is ever generated from a pattern.** `firstname.lastname@uni.edu`
  is a guess that either bounces or reaches a stranger, and the editor cannot
  tell which. Missing is recorded as `not_found`.
- **Unknown stays unknown.** An empty education section is a gap in public data,
  not a fact about the person, and it never counts against them.
- **Every stored field carries its source URL**, because a dossier has to be
  checkable.
- ORCID is not an email directory. Addresses there default to private, and only
  ones the researcher chose to publish are ever read.

## Reporting to the user

Say plainly how many candidates got an email and how many got a career history.
Poor email coverage is a fact about public data, not a failure of the run — and
the editor can often still reach people through the editorial system.
