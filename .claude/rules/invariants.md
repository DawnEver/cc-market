# cc-market Invariants

Always-injected behavioral constraints for working anywhere under `cc-market/`.

## Dev context vs. runtime context

`CLAUDE.md`, `AGENTS.md`, and `.claude/rules/*` under each plugin directory are visible to
you **now**, while developing the plugin in this repo — they are NOT injected when a skill
actually runs in a user's project. At runtime, a skill only has:

- The contents of its own `SKILL.md`
- Files it explicitly `Read`s (e.g. `skills/*/reference/*.md` linked from `SKILL.md`)
- Whatever the host project's own `.claude/` / `AGENTS.md` provides (unrelated to this repo)

When writing or editing a `SKILL.md`, never assume knowledge from this repo's `AGENTS.md`,
plugin `CLAUDE.md`, or `.claude/rules/` will be available to the agent executing the skill.
If the skill needs that knowledge to complete its task, it must be restated or linked
in-band (a `reference/*.md` file, inline instructions) — not implied.

## Always pass `windowsHide: true` to child_process

Every `spawn`/`spawnSync`/`execFileSync`/`execSync` that launches a console app
(`git`, `node`, `claude`, `claude.exe`, `codex`, `powershell`, `python`, …) from a hook,
MCP server, or background script MUST set `windowsHide: true` in its options. On Windows a
console-subsystem child gets a fresh console window allocated (a visible terminal flash)
whenever the parent has no console of its own — which is exactly the case for Claude Code
hooks and the takeover MCP server. `windowsHide` suppresses that window and is a harmless
no-op on macOS/Linux, so add it unconditionally.

Also never wrap a background launch in `cmd /c start …`: `start` spawns its **own** console
that `windowsHide` on the `cmd.exe` call cannot reach. Spawn the target (e.g. `powershell.exe`)
directly with `{ detached: true, stdio: 'ignore', windowsHide: true }` instead.

Exception: foreground launchers the user runs in their own terminal with `stdio: 'inherit'`
(e.g. `cc.js`, the `todo`/`traceme` CLI launchers) already share a console and don't flash —
`windowsHide` there is unnecessary (still harmless).

## Progressive disclosure

Keep `SKILL.md` itself short (the always-loaded part). Move detail — schemas, flag tables,
file-ownership maps, edge cases — into `skills/*/reference/*.md` and link to it from
`SKILL.md` so it loads only when relevant. Don't duplicate reference content back into
`SKILL.md` "for safety" — that defeats the disclosure and risks drift between the two.

## `.claude/rules/invariants.md` is for dev principles, not skill content

Each plugin's `invariants.md` is dev-only (not injected at skill runtime — see above), so
it must not be the place a runtime fact "lives". Don't restate values, defaults, or
behavior that `SKILL.md`/`reference/*.md` already document for the agent — link to them
instead. Two copies of the same fact (one runtime, one dev-only) drift silently, since only
the dev copy is visible while developing and only the runtime copy is visible while running
(e.g. `inlineDiffLimit` default went 20000 in `SKILL.md` vs. 40000 in `invariants.md`/
`lib.mjs`/`README.md` — nobody editing in this repo saw the mismatch). `invariants.md`
should hold things that are true ONLY for developers: internal constraints, gotchas,
ownership boundaries, "why" behind a design choice — not user-facing config/behavior.

## State file ownership (`.claude/.rem-state.json`)

Several plugins share the one gitignored state file; `shared/state.mjs` `deepMerge`
preserves keys it doesn't know about, so a plugin only ever touches its own top-level key.
Each top-level key has exactly one owner — never write another plugin's key:

| Key | Owner | Contents |
|---|---|---|
| `version` | shared/state.mjs | State schema version (bump on incompatible shape change) |
| `hook` | rem | Stop-hook gate: stop counts, `remPending`, `taskActiveUntil` |
| `prune` | rem | Prune timestamps + 15-entry event ring buffer |
| `scopes` | rem | Scope-discovery ignore patterns |
| `reviewGate` | sharp-review | Wave gate: mode, review counts, `lastReviewRef`/`lastReviewDiff` |
| `evolveState` | evolve | Round loop: findings, `lastRoundAt`, `emptyRounds` |

traceme (own SQLite DB), watch (`.claude/watch/state/alert.json`), and takeover keep state
elsewhere and must not add keys here. Adding a key: claim it in this table first, add it to
`DEFAULT_STATE` if shared, then rebundle `shared/` copies.

## Refactors carry the names and delete the dead weight

Backward compatibility is not a concern here (see AGENTS.md § Standard), so a refactor is
not done until it is *clean*:

- **Rename to match meaning.** When a file/script/symbol no longer fits what it does, rename
  it (`git mv`) and update every reference in the same change — don't leave a misnamed file
  (e.g. `codex-fan-out.md` after the path stopped being Codex-only). A stale name is a future
  reader's wrong mental model.
- **Delete what the change orphaned.** Scripts, references, or files that nothing reaches
  after a change must be removed, not left "just in case". Verify with a repo grep before
  deleting; if something is still used by another path, keep it and say why.
- **Review your own diff for simplicity.** Before committing, re-read the edit: cut
  redundancy, avoid restating the same fact in two places, keep it minimal and elegant.
