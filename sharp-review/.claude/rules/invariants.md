# Sharp Review Invariants

Dev-only constraints; the runtime procedure is `skills/sharp-review/SKILL.md` and its
`reference/*.md`, and must not drift from these.

## The method, its planner and its merge are ai-lab's
- Profiles, prompts, the finding schema, reviewer-status rules and the merge/id spec live ONLY in
  ai-lab (`ai_lab/review/method_data/`, PLAN-a-short-robust-toolchain P4), and so do the rules that
  execute them: the planner (`python -m ai_lab.review.plan`) and the merge (`python -m
  ai_lab.review.merge`). This plugin keeps NO method data and NO method logic: a weight, a prompt
  line, a pick, a status or an id format restated here is a second source — change ai-lab instead.
- `plan.js` collects the manifest (git) and calls the planner; `post-review.js` calls the merge;
  both through `lib/ai-lab.mjs`. An absent or too-old ai-lab is `AiLabUnavailable` by name, never a
  fallback. Hosts must NOT plan, merge or assign ids themselves.
- Finding ids are `SR-YYYYMMDD-NNN`, assigned by the merge — never by reviewers.
