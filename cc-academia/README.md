# cc-academia

Academic research toolchain for Claude Code and Codex: systematic literature
review, manuscript peer review, and reviewer discovery for a journal editor.

Three skill workflows over one deterministic Python library and one accumulating
local database.

## Install

Install `cc-academia` from the `DawnEver/cc-market` marketplace in the host you
use. Claude Code reads `.claude-plugin/plugin.json`; Codex reads
`.codex-plugin/plugin.json`. Installing either host is sufficient and neither
manifest refers to the other installation.

## Workflows

| Workflow | Claude Code | Codex |
|----------|-------------|-------|
| Literature review | `/cc-academia:literature-review <topic>` | invoke `literature-review` with `<topic>` |
| Manuscript review | `/cc-academia:manuscript-review <pdf>` | invoke `manuscript-review` with `<pdf>` |
| Reviewer discovery | `/cc-academia:reviewer-discovery <pdf>` | invoke `reviewer-discovery` with `<pdf>` |

## Architecture

- **Package:** skills, deterministic Python code, default policy and both native
  manifests ship together as one version.
- **Runtime:** code locates package resources from `__file__`; playbooks locate
  `<plugin-root>` from their own loaded `SKILL.md`. No plugin-root environment
  variable or cross-host compatibility layer exists.
- **Workspace:** confidential inputs and generated artifacts live outside the
package in workflow-specific directories: `ongoing/` plus `archive/` for
literature review, and `archived/` for the other workflows.
- **Personal state:** API contact details and config overrides use explicit
  `ACADEMIA_*` settings; the SQLite database stays off synced storage.
- **Host adapters:** only genuine orchestration differences—subagents, hooks,
  background work and optional MCP tools—are adapted. Domain logic and schemas
  remain shared and deterministic.

## What makes the reviewer shortlist trustworthy

Candidates are discovered as authors of demonstrably related work, never by
asking a model for names. Conflicts of interest are decided by a rule engine, not
a model, and every verdict cites the rule and the evidence behind it. A conflict
removes a candidate rather than deducting points, so no amount of topical fit can
outweigh one — as does a failed `require` eligibility rule, below. Contact
addresses are found on public pages and recorded with their source; none is ever
generated from a name-and-domain pattern.

Geographic separation uses the candidate's current affiliation country. Nothing
is inferred from a name.

Each candidate's academic position is shown — professor, lecturer, postdoc, PhD
or MSc student — because a pool harvested from authorship contains students by
construction. A position is stated by a source or left unknown.

Alongside the conflict rules there is a second, configurable gate: whether the
invitation is worth sending at all. Recent publication activity, a doctoral
year-of-study floor, responsiveness to past invitations, and the long-career
name who no longer answers any. Each rule is `off`, `prefer` or `require` in the
journal's config, and `require` removes a candidate the way a conflict does —
they stay on the list with the reason. Missing evidence always passes: an
unstated enrolment year or an empty invitation history is a gap in public data,
not a fact about the person.

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
