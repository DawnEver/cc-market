# Changelog

The version is shared by the Python package and both host manifests;
`scripts/release.py` keeps them in step and `tests/test_manifests.py` fails the
build if they drift.

## [Unreleased]

### Added

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
