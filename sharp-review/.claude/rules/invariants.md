# Sharp Review Invariants

Dev-only constraints; the runtime procedure is `skills/sharp-review/SKILL.md` and its
`reference/*.md`, and must not drift from these.

## The method is data
- Profiles, prompts, the finding schema, reviewer-status rules and the merge/id spec live ONLY
  in `method/`. Scripts read them; a script that restates a weight, a prompt line, a default or
  an id format is a second source — move it into `method/` instead.
- A behaviour change to the method changes `method/` AND a `method/conformance/` fixture in the
  same commit; the fixtures, not the Node code, are what ai-lab's executor follows (and the merge is ai-lab's
  alone: a merge behaviour change lands in ai-lab with its fixture).
- Bump `schema_version` on any change an executor reading the old version would misread.

## Merge / render
- Hosts fan out reviewers; merge, status and ids run only in ai-lab (`python -m
  ai_lab.review.merge`), reached from `post-review.js` via `lib/ai-lab.mjs`. This plugin keeps NO merge code,
  and an absent or too-old ai-lab is `AiLabUnavailable` by name, never a fallback. Hosts must NOT
  merge or assign ids themselves.
- Finding ids are `SR-YYYYMMDD-NNN`, assigned by the merge — never by reviewers.
