# cc-academia

Academic research toolchain for Claude Code and Codex: systematic literature
review, manuscript writing in LaTeX, manuscript peer review, and reviewer
discovery for a journal editor.

Skill workflows over one deterministic Python library, one public knowledge base
(`knowledge/`) and one accumulating local database.

## Install

Install `cc-academia` from the `DawnEver/cc-market` marketplace in the host you
use. Claude Code reads `.claude-plugin/plugin.json`; Codex reads
`.codex-plugin/plugin.json`. Installing either host is sufficient and neither
manifest refers to the other installation.

## Workflows

| Workflow | Claude Code | Codex |
|----------|-------------|-------|
| Literature review | `/cc-academia:literature-review <topic>` | invoke `literature-review` with `<topic>` |
| Manuscript review | `/cc-academia:review submission <pdf>` | invoke `review` with `submission <pdf>` |
| Reviewer discovery | `/cc-academia:referee-discovery <pdf>` | invoke `referee-discovery` with `<pdf>` |
| Manuscript writing | skill `write` (draft, revise, compress, figure, table, data) | invoke `write` |
| Review of your own edit | skill `review` with target `own` (lint, `review-writing` agent, compile, page budget) | invoke `review` with `own` |
| Writing knowledge | skills `field-reading`, `style-profiling`, `ruling-capture` | same names |
| Word counts | skill `count-tex` (`academia-write word-count`) | invoke `count-tex` |

Literature review asks once for an output language (`workspace.toml` → `[output]
language`, e.g. `"zh-CN"`, default `"en"`). Briefs, screening explanations, paper cards
and synthesis are written in it; keys, enums, titles, authors and DOIs never change.

## Writing a manuscript

Start with the `write` skill: its hard constraints (author-led parts, approved
text, figure approval, page budget) apply to every edit. A paper names its
venue, fields and style preset in `<paper>/.academia/profile.tsv`. An agent
loads only the rules of the part it edits, one line each, and expands one item
on demand; everything a machine can check is left to lint, whose hits name the
rule and its remedy:

```shell
academia-write resolve --task write|review --scope <part>   # context index for an agent (one line per item)
academia-write explain <id>                                  # one rule, criterion or dimension in full
academia-write resolve [--md|--json|--criteria]              # full dump for humans; jurisdiction errors
academia-write lint-prose [files] [--min error|warn|info]
academia-write lint-table [files]
academia-write check-data [--write]               # numbers.tsv -> numbers.tex (\val{id})
academia-write page-budget [main.pdf]
academia-write word-count [dir] [--target N]
academia-write check-figure <script.py> <function> [--baseline layout.json]
```

Run each as `uv run --project "<plugin-root>" academia-write ...`. The figure library
is `academia.figure` (extra `plot`). How the knowledge is organised (sources,
objects, scope, presets, policy) and how to add to it: `knowledge/README.md`.

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
year-of-study floor, seniority, and related-journal evidence. Each rule is
`off`, `prefer` or `require` in the policy, and `require` removes a candidate the way a conflict does —
they stay on the list with the reason. Missing evidence always passes: an
unstated enrolment year is a gap in public data,
not a fact about the person.

TIE, TII, TTE and TEC share the shipped IEEE policy in `knowledge/common/policy/coi.toml`.
Personal overrides use `ACADEMIA_CONFIG_DIR`. Reports measure address coverage
per class: the default targets are 90% for `recommend` + `check_first` and 60%
for other candidates, configurable under `[coverage]`. Identity links prefer
IEEE Xplore author profiles when an IEEE author identifier is available.

Contact extraction preserves HTML block boundaries and reads fragmented or
obfuscated addresses as displayed. Initials-based accounts, including numeric
suffixes, remain weak matches and are accepted only when unambiguous.

## Working across machines

The SQLite store stays on local disk — syncing a WAL-mode database through
OneDrive corrupts it. The facts that cannot be re-derived travel instead:
invitations and their outcomes, verified ranks, public addresses, corrected
affiliations and doctorate years, written as JSON Lines, one directory per
device, every record carrying the URL that stated it.

This is off by default and never chooses a location on its own: the files hold
real people's addresses and employment, so putting them in a shared or cloud
folder has to be a deliberate act. Set `ACADEMIA_FACTS_SYNC=1` and
`ACADEMIA_FACTS_DIR`; `academia-referee facts` runs it by hand and `academia doctor`
says where the folder is.

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
