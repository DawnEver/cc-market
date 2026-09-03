# Changelog

The version is shared by the Python package and both host manifests;
`scripts/release.py` keeps them in step and `tests/test_manifests.py` fails the
build if they drift.

## [Unreleased]

### Removed

- **The windowed `invitation_response` rule.** It asked the veteran rule's
  question over a shorter window, so the two agreed by construction, and on any
  store without a long invitation history both abstained. Silence is now a
  reason only alongside a long career. Invitation history still feeds the
  veteran gate and the `reviewer_history` score component.
- **`geo.bonus`.** Computed into every assessment and never read: the score uses
  the component and `scoring.geographic`, which held the same 0.08, so tuning
  `geo.bonus` changed nothing. The weight is stated once, where every other
  weight lives.
- **The second identity-confidence threshold.** 0.8 sent a candidate for
  confirmation and a separate hardcoded 0.6 added a note saying the same thing,
  so a candidate at 0.7 was flagged for a human without being told why. One
  configurable `identity.min_confidence`.

### Changed

- **The eligibility rule layer, rebuilt from first principles.** No
  compatibility kept: `eligibility.assess` takes a `CandidateRecord` and the
  policy exposes `constraint(<rule name>)` instead of a property per rule.
  - **One derivation per quantity** (`reviewer/record.py`). Career length was
    derived twice — `career_length` from the run's harvest, `unresponsive_veteran`
    from the person's publication profile — and on a live case the two
    disagreed for 158 of 197 candidates by as much as 28 years, in adjacent
    columns of the delivered spreadsheet. The one reading the harvest was the
    preference for early-career reviewers, so a 32-year veteran collected the
    early-career bonus because the search had only found his recent papers.
  - **`academic_age` and `career_length` become one `seniority` rule.** They
    were a floor and a ceiling on the same axis, and coincided whenever a
    doctorate year was stated. The basis — doctorate, else first publication —
    is now reported, because the two are different claims. The floor obeys the
    mode; the ceiling can never exclude anybody, enforced in the rule rather
    than trusted to the config, because a `require` ceiling once removed every
    senior researcher in a pool and left a run with nobody to invite.
  - **One registry.** All eight rules are in `eligibility.RULES` and run by one
    loop. Three used to be appended by `rank` *after* `Assessment.score` had
    been computed, so a `prefer` rule added there fed nothing; `score` is a
    property now, and abstentions are excluded from its denominator.
  - **Uniform abstention.** A rule with no evidence says so instead of printing
    as a pass, which two of them did.
  - **Facts are named `<rule>_<fact>`,** so the workbook groups columns by the
    rule that produced them rather than by a hand-kept prefix table that had
    already drifted. `*_known` and `*_gap` columns are gone — the VERIFY verdict
    and the threshold beside the value already carry them. 75 audit columns → 55.
  - Config: `[seniority]` takes `mode`/`min_years`/`max_years`;
    `min_academic_age`, `max_academic_age` and `[seniority.career]` are removed.

- **Reviewer discovery hands over one file.** `rev-disc report` now writes
  `ongoing/<slug>/<slug>.xlsx` itself, beside the manuscript it is about, and
  that workbook is the whole deliverable. It is named after the case rather
  than after its contents because once it has been mailed on it has to say
  which submission it belongs to on its own. Everything in `5-shortlist/` —
  the two CSVs, the reading list, the dossiers — stays behind as working
  material for disputing a verdict.
  - `scripts/audit_xlsx.py` becomes `academia.reviewer.workbook`, and
    `openpyxl` moves from the optional `xlsx` extra into the dependencies: a
    run that cannot write a workbook has produced nothing to hand over. Rebuild
    one from a CSV already on disk with
    `python -m academia.reviewer.workbook <...>/contact-list-audit.csv`.
  - Writing over a workbook that is open in Excel now reports which file to
    close instead of an errno.

### Fixed

- **A candidate with no public address is no longer told not to invite them.**
  `invitation_readiness` rejected anybody without a verified address, so the
  workbook's headline column read "Do not invite" for people every rule had
  cleared — eight of ten invitable candidates on one live TTE case, purely
  because enrichment reaches only about a fifth of this field. It is now
  `check_first`, reason "no public address found — invite through the editorial
  system", which is what the contact list's own documentation already claimed
  and what the project's rule that a missing fact disqualifies nobody requires.
- **A conflict marked for review is no longer reported as a blocking reason.**
  The audit export collapsed `REVIEW` into `FILTERED`, so the workbook printed
  "Conflict of interest with the authors" in `Why not recommended` against
  candidates it simultaneously recommended checking — two of them on a live TTE
  case. A review-level conflict asks for a human; it excludes nobody. The
  column now carries all three states and only an excluding verdict names a
  reason.
- **Intake reads the editorial cover sheet properly.** Three defects, all found
  by re-verifying the workflow against live TTE proofs:
  - Two shipped regexes carried a literal backspace where a word boundary was
    meant, and matched nothing at all: the pattern that recognises an
    institution never recognised a university or a laboratory, and the one that
    closes the cover's author block never closed it. Between them an
    affiliation line and the `Additional information` heading became submitting
    authors. A test now refuses any control character in the module.
  - The title and keywords are read off the cover sheet when it has them. A
    proof whose IEEE template placeholder was never edited has no title of its
    own at all, and the manuscript's `Index Terms` sit against the
    introduction — one live run took its last two keywords from the first two
    sentences of it and searched for the wrong thing.
  - `pdf_text` falls back to the plainer reader whenever the layout reader
    fails, not only when it is missing. Installing the `pdf` extra could
    previously make a PDF unreadable that had been readable without it.

### Added

- **Homepage-or-paper link** on the `decision` sheet and in `shortlist.csv`
  (`profile_url`): the candidate's ORCID record, else their publication
  profile, else the paper of theirs closest to this manuscript, whichever says
  most about the person. Clickable, and only ever a page that was observed —
  no constructed search, no university homepage guessed from a name. A
  plausible dead link in the only file the editor receives is worse than an
  empty cell.
- **Restricted countries** (`geo.restricted` in `configs/coi.toml`). A standing
  refusal to invite from named countries, separate from the cross-region
  preference: that one spreads a review across regions, this one is a sanctions
  regime or a publisher instruction. Read from the current affiliation, never
  from nationality or from a name. Off and empty by default, because refusing a
  whole country is a decision an editor makes explicitly; a switched-on rule
  with an empty list, or one naming something that is not a two-letter ISO code,
  is refused at load time rather than silently passing everybody. An unknown
  affiliation country is flagged for confirmation rather than guessed. TTE sets
  it to `["IN", "IR"]`.
- **Related-journal floor** (`activity.related_journals`). Requires that enough
  of the evidence which qualified a candidate be journal work rather than
  conference papers — a review report is a journal genre. Counted over the
  relevant evidence, so it asks whether somebody has published journal work on
  *this* topic, not how much they publish. Evidence now carries `venue` and
  `venue_type`; a paper whose venue type no source stated is reported rather
  than counted, and a candidate who would clear the floor if only those were
  resolved is sent to manual review instead of being failed. TTE requires 3.
- **Configurable reviewer eligibility** (`activity`, `seniority.doctoral`,
  `activity.invitations`, `activity.veteran` in `configs/coi.toml`). Prefers
  authors publishing inside a recent window, holds doctoral candidates to a
  year-of-study floor, and drops the long-career name that never answers an
  invitation. Each rule has its own `off`/`prefer`/`require` mode and its own
  window, so a journal moves one number rather than forking the pipeline.
  Missing evidence always passes, and that part is not configurable: an empty
  invitation history, an unresolved outcome or an unstated enrolment year is a
  gap in public data, not a fact about the person.
- **Per-year publication output** from OpenAlex (`counts_by_year`), stored in
  `person_output` and used by the activity and veteran rules. Reading activity
  off the harvested papers instead flagged 19 of 22 candidates on a live TTE run
  as dormant, Z. Q. Zhu among them, because the harvest only holds work on this
  manuscript's topic.
- **Sourced corrections in the `--homepages` hand-back**: `phd_start_year` /
  `phd_year` (+ `doctorate_source`) and `institution` / `institution_country`
  (+ `institution_source`). The doctoral-year floor could not be applied to
  anybody before this — ORCID states an enrolment year for a minority — and a
  verified current affiliation now outranks the bibliographic guess, which on a
  live run had Z. Q. Zhu at Beihang rather than Sheffield and scored his country
  accordingly.
- **`contact-list.csv`** — name, email, institution, nothing else, written by
  `report` beside the full shortlist. Blocked candidates are excluded from this
  export alone.
- **Portable facts (`rev-disc facts`)** — the five things in the store nobody
  can re-derive (invitations, verified ranks, addresses, corrected affiliations,
  doctorate years) are exported as JSON Lines into a synced folder, one
  directory per device. Off unless `ACADEMIA_FACTS_SYNC=1`, and the location is
  always `ACADEMIA_FACTS_DIR` — nothing is copied anywhere by default, because
  these records are real people's addresses and employment. The database keeps
  to local disk regardless: WAL mode and a file-level syncer corrupt each other
  silently.
- **`rev-disc invite`** — record an invitation and its outcome. Invitation
  history feeds the next manuscript's ranking and is the only evidence the two
  responsiveness rules have; until now nothing could write it.

- **reviewer-discovery** — candidate peer reviewers for a journal submission.
  Candidates are found as authors of demonstrably related work, never by asking a
  model for names. A deterministic rule engine decides conflicts of interest and
  cites the rule and evidence for each verdict. Geographic separation uses the
  candidate's current affiliation country; nothing is inferred from a name.
  Contact addresses are found on public pages with a recorded source, never
  generated from a pattern.
- **Accumulating store** — SQLite + FTS5 holding papers, people, institutions,
  career history, the co-author graph and invitation history. Each run makes the
  next one cheaper and better informed.
- **Source layer** — OpenAlex (primary for both papers and authors), IEEE Xplore,
  ORCID, Semantic Scholar, arXiv and DBLP behind a `PaperSource`/`AuthorSource`
  split.
- **literature-review** and **manuscript-review** migrated in, sharing the same
  library, the same PDF ingest and the same store.

### Changed

- `record_affiliation` no longer duplicates an undated affiliation. `year_from`
  is part of the primary key and SQLite treats every NULL as distinct, so
  `ON CONFLICT` never fired: with facts syncing on, 23 people became 458k rows.
- `_record_doctorate` no longer falls back to the current employer as the alma
  mater. A doctorate is rarely from where someone works now, and the fallback
  wrote "PhD, Beihang University" for a candidate whose only link to Beihang was
  a mis-parsed author index.
- `[scoring]` gains `activity = 0.07`, taken from `topic` (0.40 → 0.35) and
  `geographic` (0.10 → 0.08). Scores are not comparable with earlier shortlists;
  a journal that wants the old ranking sets `activity = 0.0` and keeps the gate.

- One HTTP and retry policy for every source, replacing four divergent copies.
- Record normalisation happens once, in `litreview.candidates`, rather than once
  per source.
- The 772-line pipeline orchestrator is dissolved into the modules that own each
  phase.
- Workspace location is a user setting (`ACADEMIA_DATA_ROOT`) rather than the
  result of walking up the tree looking for a project marker.

### Removed

- `acquire()` from the source interface — every implementation raised
  `NotImplementedError`; downloading is a transport concern.
- Backward compatibility with the pre-migration import paths, CLI flags and
  directory layout.

### Fixed

- A dead statement after `continue` in section extraction.
- `acquire_pdfs` imported from the wrong module in the acquire workflow.
- The Zotero MCP launcher resolving `.env` and `sys.path` as if it were a loose
  script rather than a console entry point.
- An off-by-one in the co-authorship window: `coauthor_years = 5` now means five
  years ending with the submission year, not six.

### CLI contract changes

New surface. `lit-review` keeps its command names; every invocation now runs
through `uv run --project ${CLAUDE_PLUGIN_ROOT}`.
