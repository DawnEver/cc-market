# traceme Invariants

Dev-only constraints on the traceme plugin — not restating the agent-facing CLI commands
in `skills/traceme/SKILL.md` or the data model in `skills/traceme/reference/data-model.md`
(the runtime sources of truth, which must not drift from these).

## Hooks

- Hooks never block — always exit 0. Errors logged to `~/.claude/traceme/error.log`.

## Data

- DB at `~/.claude/traceme/traceme.db` — outside git repo, local only, fully rebuildable from
  transcripts via `rescan`.
- Zero npm dependencies — uses Node 24 `node:sqlite` built-in.
- Prompt text is **never** stored or read — the scanner only counts prompts; it never persists
  their content. Structural guarantee, not a convention.
- Sync repo contains ONLY `.enc` files — no plaintext ever touches GitHub.

## Scan

- Scan is idempotent: a session is fully recomputed and replaced on each pass; aggregates are
  query-time only.
- Project grouping identity is `repo_origin` (normalized git remote), not basename.
  Remote-less repos share `''` and merge. Dashboard suffixes remote tail when one basename
  maps to >1 remote.

## Tests

```bash
node --test cc-market/traceme/tests/*.test.mjs
```
