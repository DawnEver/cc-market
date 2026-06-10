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
