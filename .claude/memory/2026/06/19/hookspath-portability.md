---
name: hookspath-portability
description: core.hooksPath must stay RELATIVE (scripts/git-hooks) — absolute paths break across OneDrive-synced machines
metadata:
  type: gotcha
---

# core.hooksPath must be relative, not absolute

The cc-market repo is synced via OneDrive across machines with different user folders
(`linxu`, `ezxmb14`). `core.hooksPath` lives in `.git/config`; if set to an **absolute**
path it points at one machine's user dir and silently fails on the other — git runs **no
hooks**, so pre-commit (scoped tests) and pre-push (version bump + tag) never fire. Symptom
seen: a pushed commit had no plugin version bump and no release tag.

- Root fix: `git config core.hooksPath "scripts/git-hooks"` (relative). This is exactly
  what `scripts/setup.sh` sets — drift to an absolute path is the bug.
- Verify: `git rev-parse --git-path hooks` → `scripts/git-hooks`; an empty commit prints
  `pre-commit: ...`.
- Minor caveat: relative hooksPath resolves against the cwd of the git command, so
  committing from a subdir won't find hooks — acceptable vs. absolute breaking entirely.
- Catch-up when a bump is missed: the prior commit is already pushed (don't amend
  published history); replicate the hook in a follow-up commit (bump touched plugins +
  marketplace, tag `vX`), and since a shared/ change fans out to all plugins, bump all 6.
  Tagging HEAD makes the now-fixed pre-push hook no-op (`git describe --exact-match`).
