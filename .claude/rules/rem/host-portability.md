# Host and machine portability

Crystallized from memory: `2026/06/19/hookspath-portability`, `2026/06/21/codex-rules-and-global-agents`.

## `core.hooksPath` must stay relative

This repo syncs across machines with different user folders (`linxu`, `ezxmb14`), and
`core.hooksPath` lives in `.git/config` — untracked, per-clone. An absolute path points at
one machine's user directory and silently fails on the other: git then runs **no** hooks, so
pre-commit (scoped tests) and pre-push (version bump + tag) never fire. The symptom is a
pushed commit with no plugin version bump and no release tag.

- Correct value: `git config core.hooksPath "scripts/git-hooks"`, exactly what
  `scripts/setup.sh` writes. Drift to an absolute path is the bug.
- Verify with `git rev-parse --git-path hooks` → `scripts/git-hooks`.
- Caveat accepted on purpose: a relative hooksPath resolves against the cwd of the git
  command, so committing from a subdirectory finds no hooks. Better than absolute, which
  breaks everywhere but one machine.
- When a bump was missed, do not amend published history: replicate the hook's work in a
  follow-up commit (bump every touched plugin plus the marketplace, tag `vX`). A `shared/`
  change fans out to all plugins, so bump all of them.

## Codex does not auto-load `.claude/rules/`

Claude Code injects every `.claude/rules/**/*.md` each session; Codex has no such mechanism.
The bridge is `rem/scripts/inject-rules.js`, a `SessionStart` hook that globs the host
project's rules and emits them as `additionalContext` **only under Codex** — under Claude
Code it would duplicate what the host already injected. Host detection reads the resolved
`${CLAUDE_PLUGIN_ROOT}`: Codex substitutes it beneath `.codex/plugins/…`, Claude beneath
`.claude/plugins/…`.

rem owns this because rem crystallizes memory into the host project's `.claude/rules/rem/` —
precisely the content that would otherwise be invisible to the other host.

Codex's global instructions file is `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md`), the
mirror of `~/.claude/CLAUDE.md`. `GLOBAL-AGENTS.md` is the single source and `setup.js`
symlinks it to both.
