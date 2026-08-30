# cc-academia

Three research workflows over one library: systematic literature review,
manuscript peer review, and reviewer discovery for a journal editor.

> **Principles only.** Operating instructions — commands, flags, troubleshooting —
> live in the skill playbooks under `skills/`. Principles and operations stay
> apart; when they disagree, the playbook is authoritative for *how* and this
> file is authoritative for *why*.

## Why one plugin

The three workflows share the scholarly sources, one PDF ingest, one AI backend
selection, and one accumulating database. Split into three plugins, the shared
playbooks would have nowhere to live and the coordination problem would return.

Shipping the library in the same tag as the playbooks that call it removes an
entire class of problem: there is no cross-repo contract, so there is no lock
file, no contract hash and no version check anywhere in this plugin. When a
change needs one, that is a signal the seam was cut in the wrong place.

## Environment

**Keep the build environment off OneDrive.** This plugin lives inside cc-market,
which syncs. Left alone, `.venv` and the pytest/ruff caches are copied
file-by-file by the sync client on every dependency change.

Point uv at local disk — **per shell, not globally**:

```powershell
$env:UV_PROJECT_ENVIRONMENT = "$HOME/Documents/PEMC/cc-academia-data/venv"
```

```bash
export UV_PROJECT_ENVIRONMENT="$HOME/Documents/PEMC/cc-academia-data/venv"
```

Do **not** `setx` it. The variable names a path, not a policy, so a machine-wide
value would make every uv project on the machine share this one environment.
`.claude/settings.json` sets it for agent sessions in this directory, which is
the scope that actually matches.

The accumulating SQLite database defaults to local disk for a harder reason: a
sync client corrupts database files. `ACADEMIA_DB` may be moved, but never onto a
synced folder.

## Configuration layering

Defaults ship here; personal customisation overrides them. Neither forks the
other.

| Variable | Default | What it controls |
|----------|---------|------------------|
| `ACADEMIA_CONFIG_DIR` | `configs/` | COI policy, journal parameters |
| `ACADEMIA_LENS_DIR` | `configs/lenses/` | domain appraisal lenses |
| `ACADEMIA_DATA_ROOT` | `~/cc-academia-data` | where workflow data live |
| `ACADEMIA_DB` | the platform's local application-state directory (`%LOCALAPPDATA%\cc-academia` on Windows, `~/Library/Application Support/cc-academia` on macOS, `$XDG_DATA_HOME/cc-academia` on Linux) | the accumulating store. Never under `Documents` or any folder a person would sync: WAL-mode SQLite and a file-level syncer corrupt each other |
| `ACADEMIA_CONTACT` | unset | polite-pool address for OpenAlex, Crossref, ORCID |

A file present in the override directory wins; anything absent falls back here.

## Source hierarchy — established by probing, not by documentation

| Need | Primary | Why |
|------|---------|-----|
| Institutions, countries, career timelines | OpenAlex | the only source returning ROR-linked institutions with ISO country codes and a per-author affiliation year series. CC0, so it may be cached |
| Relevance inside IEEE venues | IEEE Xplore | best ranking for its own catalogue, and a persistent author id for free |
| Degrees and alma mater | ORCID | the only structured source, filled for roughly 30% of this field |
| Open-access PDF links | Semantic Scholar, arXiv | S2 needs a key; arXiv links are the most reliable |
| CS venue coverage | DBLP | complete, metadata only |

Two findings that shaped the design:

- **IEEE search returns no affiliations and no index terms.** Institutions and
  controlled vocabulary must come from OpenAlex.
- **Semantic Scholar's author endpoints answer an unauthenticated call with HTTP
  429.** They are a keyed extra, never a dependency.

Re-record the fixtures with `scripts/record_fixtures.py` when a source changes
shape. The test suite never touches the network, so a broken API breaks the
recording step rather than the build.

## Identity — never by name

Researchers are resolved by ORCID, then OpenAlex id, then IEEE author id, then
Semantic Scholar id. Name matching is banned as an identity mechanism: a live
probe for a common name returned a researcher from an unrelated field. Where
confidence is low it is carried into the output and marked, not hidden.

## Conflicts of interest are decided by code

No model ever decides whether a conflict exists. Every verdict carries a rule and
its evidence, because an editor may have to justify a rejection in writing.

A `BLOCK` sets the score to negative infinity rather than deducting points.
Blending "expertise 95, conflict −20" into 75 is how a disqualified reviewer ends
up on a shortlist.

A clean result is always worded **no detected conflict** — never "no conflict".
A bibliographic database cannot prove the absence of a personal, financial or
competitive relationship.

## Eligibility is policy, not expertise

Whether someone *could* review a manuscript and whether the invitation is worth
sending are separate questions, and they are answered separately: expertise is a
score, eligibility is a gate.

Every eligibility rule — the activity window, the doctoral year-of-study floor,
invitation responsiveness, the unresponsive long-career expert — is a key in
`configs/coi.toml` with its own `off` / `prefer` / `require` mode. A `require`
failure sets the score to negative infinity for the same reason a `BLOCK` does.
A `prefer` failure only annotates and feeds one score component, so an editor
can see it and disagree.

Missing evidence always passes. No publication years, no stated enrolment year,
no invitation history — each is a gap in public data. A rule that fired on
absence would remove the people with the thinnest public records rather than the
people the policy is about, and the invitation-based rules are therefore inert
on a fresh store, by design.

## The store is a cache; five facts are not

Everything in the database comes back by re-running the pipeline — papers,
authorships, resolved identities, OpenAlex affiliations, yearly output. Five
things do not, because a person paid to establish each one: **invitations and
their outcomes, a rank read off a page, an address found on a page, a corrected
affiliation, and doctorate years.** Every one of them carries the URL that
stated it.

Those five can be exported as line-oriented JSON, under one directory per
device, into whatever folder `ACADEMIA_FACTS_DIR` names.

**Export is off unless `ACADEMIA_FACTS_SYNC=1`, and it never picks the folder
for you.** These files hold real people's addresses and employment. Copying them
into a cloud folder — an institutional OneDrive above all — is a decision about
someone else's personal data, and a default that made it silently would be
wrong however convenient it is. Import merges every device's files;
export only ever writes this device's. Two machines therefore never write the
same path, so a folder syncer has no conflict to resolve, and a "conflicted
copy" left behind by one is still read.

**The database itself is never synced.** It is SQLite in WAL mode, whose
consistency depends on the `-wal` sidecar matching the main file; a file-level
syncer uploads them independently and the failure mode is a silently mixed pair,
not an error. `paths.database_path()` deliberately resolves outside the data
root for this reason.

Anything added to the portable set must be a *stated* fact with a source, and
merging it must be idempotent — automatic sync runs on every command, so a
non-idempotent merge grows the store without bound. One already did: an
affiliation with a NULL `year_from` cannot be matched by `ON CONFLICT`, because
SQLite treats every NULL as distinct, and re-importing turned 23 people into
458k rows.

## Geography, not ethnicity

Cross-region separation operates on the candidate's **current affiliation
country**. Nothing is inferred from a name. A Chinese researcher now at Stanford
counts as US: more accurate, and it avoids profiling reviewers by ethnicity — a
proxy that is unreliable and that an editor could not defend. Unknown is neutral.

## Contact addresses are found, never generated

Published corresponding address, institutional page, lab page, public ORCID —
each recorded with its source URL and a confidence. Nothing else. A guessed
address either bounces or reaches a stranger and the editor cannot tell which, so
absent is reported as `not_found`.

Automatic discovery reaches roughly a fifth of candidates in IEEE-adjacent
engineering, which was measured rather than assumed. The rest come back through a
worklist an editor or agent resolves by searching — and they hand back **the URL,
never the value**. The tool fetches the page and extracts, so "found, never
generated" holds even with a model in the loop, and a search snippet that has
gone stale cannot become an invitation.

## A blank field beats a confident wrong one

Academic rank is stated by a source or left `unknown`. It is never inferred from
a publication record, and it is not scraped out of arbitrary HTML: reading it
from the text around a name on a staff page was implemented and then removed,
because it called an associate professor an MSc student and a full professor
unknown.

An editor acts on these fields. A wrong rank means a good reviewer is dropped and
nobody ever sees why, whereas a blank one is visibly a question. This is the same
reason `unknown` is neutral everywhere else — geography, seniority, education —
rather than counting against anyone.

## Manuscript confidentiality is enforced in the tool

Codex may not support Claude Code's hooks, so a permission rule can never be the
only lock. The CLI itself never emits manuscript body text — only
`sanitized.json`. `hooks/guard-manuscript.mjs` is a second lock on the Claude
side, and a prompt instruction is not a lock at all.

External searches carry derived keywords, never the abstract. The database stores
a hash of the manuscript title, never the title.

## Two hosts, one playbook

The library derives its immutable plugin root from its own module path. A
playbook resolves `<plugin-root>` from the loaded skill path; no host-specific
environment variable participates. Genuine host differences are collected in
`skills/_shared/host-adapters.md`.

Manifest versions are kept in step by `scripts/release.py`, guarded by
`tests/test_manifests.py`. Never hand-edit a version.

## Agent naming

All three workflows ship in one plugin, so agent names carry a workflow prefix:
`literature-*`, `manuscript-*`, `discovery-*`. A collision would silently route
work to the wrong reviewer.

## Testing

TDD, and no network. External APIs are exercised through recorded fixtures under
`tests/fixtures/`; `tests/conftest.py` fails any test that opens a socket.
Fixtures are scrubbed of subscriber identity before they are written, because
this repository is public.

## Details

Progressive disclosure — read as needed:

- Workflow steps → `skills/<workflow>/`
- Running the CLI → `skills/_shared/running-the-cli.md`
- Host differences → `skills/_shared/host-adapters.md`
- COI policy and journal parameters → `configs/coi.toml`, `configs/journals/`
