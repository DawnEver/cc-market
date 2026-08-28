# Changelog

All notable changes to cc-academia. The version number is shared by the Python
package and all four host manifests; `scripts/release.py` keeps them in step and
`tests/test_manifests.py` fails the build if they ever drift.

## [Unreleased]

### Added
- Repository scaffolding: single plugin serving both Claude Code and Codex, with
  the Python library it drives in the same tag.
- `core/`: path resolution with a user override layer, one HTTP/retry policy for
  every source, text normalisation and record de-duplication, domain models.
- `store/`: SQLite + FTS5 schema and an upsert-only repository covering papers,
  people, institutions, career history, the co-author graph and run artefacts.
- `sources/`: OpenAlex (papers *and* authors), IEEE Xplore (search), ORCID
  (education and employment).
- `academia doctor` / `academia db {init,stats,vacuum}`.

### CLI contract changes
- New surface; nothing to migrate yet.
