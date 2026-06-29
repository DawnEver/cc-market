---
name: subagent-workflow-design
description: Design analysis — letting subagents manage workflows for reuse + context isolation
metadata:
  type: project
---

# Subagent-Managed Workflow — Design Analysis

## Problem

Two capabilities in tension:

| Capability | Has `Workflow` tool | Context isolation | Reusable orchestration |
|---|---|---|---|
| Main loop | Yes | No (session context) | Yes (workflow scripts) |
| Subagent | No | Yes | No (ad-hoc prompt per use) |

**Current compromise** (sharp-review Step 3b): The worker subagent manually fans out reviewers
via takeover MCP / Agent tool. It duplicates the orchestration logic that
`sharp-review-workflow.js` already encodes — parallel fan-out, seed-mod rotation, schema
enforcement, dedup — but as ad-hoc prompt instructions instead of a reusable script.

**Goal**: Let a subagent act as a "conductor" that executes a reusable workflow definition
(spawning workers, collecting structured results, merging), achieving both context isolation
(from the main session) and deterministic orchestration (from the workflow pattern).

## Core tension: why `Workflow` is main-loop-only

The `Workflow` tool spawns subagents via `agent()`. If a subagent could call Workflow, those
would be sub-subagents — which spawn sub-sub-subagents in pipeline stages. Claude Code's
agent model is flat (main → subagent, no deeper nesting). The Workflow tool is essentially
syntax sugar over `parallel(agent(...))` calls; restricting it to the main loop keeps the
agent tree depth at 1.

So the real question isn't "how to give subagents Workflow" but "how to encode workflow
orchestration as a reusable pattern that works within the flat agent model."

## Three architectural patterns

### Pattern A: Conductor Prompt Template (lightweight, today)

The subagent receives a reusable prompt that encodes the full orchestration: fan-out
strategy, per-worker prompt template, output schema, merge rules. It spawns workers via
`Agent` tool, collects `StructuredOutput`, and hands raw results to a shared deterministic
merge function (e.g. `post-review.js --raw`).

```
Main loop
  └─ Conductor subagent (runs "workflow prompt template")
       ├─ Worker agent A  (Agent tool + schema)
       ├─ Worker agent B  (Agent tool + schema)
       └─ Merge: spawn post-review.js (deterministic, no AI involved)
```

**What's reusable**: The conductor prompt template lives in a skill's `reference/` and can
be invoked by any skill that needs parallel-fan-out-with-merge. The shared lib (merge,
dedup, render) stays in `.mjs` files — the conductor just calls them as a final step.

**What's ad-hoc**: The conductor's fan-out logic (order, error handling, fallback) is
model-interpreted from the prompt, not executed deterministically like a workflow script.

**This is essentially what sharp-review Step 3b already does**, but the orchestration
instructions are inlined in SKILL.md rather than factored out as a reusable template.

### Pattern B: Workflow Script → Prompt Compiler (build-time)

The existing `sharp-review-workflow.js` is a deterministic script with `agent()`,
`parallel()`, `pipeline()`, `phase()`. For a subagent to "run" it, we'd need a compiler
that converts the workflow script into a conductor prompt:

```
workflow.js  ──[compiler]──>  conductor prompt (text)
                                │
                                ├─ "Spawn N agents in parallel with these prompts..."
                                ├─ "Each must return this schema..."
                                ├─ "Merge rules: dedup by file+summary, assign IDs..."
                                └─ "Call post-review.js --raw with the collected results"
```

The compiler reads the workflow script's `agent()` calls, extracts per-agent prompts,
schemas, and merge logic, and emits a self-contained conductor prompt. The conductor
subagent executes it with Agent tools + a final PowerShell call to the shared lib.

**Pros**: Single source of truth — the `.js` workflow is the canonical definition; the
prompt is derived. Both main-loop (Workflow VM) and subagent paths use the same spec.

**Cons**: The compiler must parse a subset of JS (the workflow DSL) and translate it to
natural-language instructions. Fragile unless the DSL surface is tiny and stable.

### Pattern C: Conductor Agent Type (platform-level)

A built-in agent type (like `sharp-review:sharp-review`) that has orchestration primitives
in its system prompt: "You are a workflow conductor. When given a workflow definition
(reviewers[], schema, mergeRules), you MUST: (1) spawn all reviewers in parallel via Agent
tool, (2) collect StructuredOutput from each, (3) passthrough raw results — never merge
yourself." The workflow definition is a JSON-serializable config passed in the agent's
prompt.

```
Main loop
  └─ Conductor agent (type: "workflow-conductor")
       ├─ Receives: { reviewers: [...], schema: {...}, mergeCmd: "post-review.js --raw" }
       ├─ Spawns workers in parallel
       └─ Calls merge command with collected results
```

**Pros**: The orchestration pattern is platform-level, not per-skill. Any skill can
instantiate a conductor with a JSON config. The conductor's behavior (parallel spawn,
collect, passthrough) is enforced by its system prompt, not reinterpreted each time.

**Cons**: Requires a new agent type. The "never merge yourself" constraint is soft
(prompt-enforced, not code-enforced). Still relies on external deterministic merge (the
shared `.mjs` lib) for byte-identical output.

## Recommendation: Pattern A → C evolution

**Near term (Pattern A)**: Extract sharp-review's Step 3b fan-out instructions into a
reusable reference doc (`reference/conductor-pattern.md`). It's a prompt template
parameterized by `{reviewers, schema, mergeCmd}`. Any skill that needs subagent
orchestration copies the pattern. Low cost, works today.

**Medium term (Pattern C)**: If conductor orchestration is used by ≥3 skills, promote it
to a dedicated agent type. The agent's system prompt hard-codes the orchestration loop
(spawn parallel → collect → call merge command). Skills pass a JSON workflow config.

## Concrete design for a reusable conductor

### Workflow config (what the caller passes)

```json
{
  "workers": [
    { "key": "A", "prompt": "Review this diff for bugs...", "schema": { "...": "..." } },
    { "key": "B", "prompt": "Review this diff for perf...", "schema": { "...": "..." } }
  ],
  "merge": {
    "command": "node \"$env:CLAUDE_PLUGIN_ROOT/scripts/post-review.js\" --raw \"$env:TEMP/claude-sharp-review/raw.json\"",
    "rawJsonSchema": {
      "reviewers": [...],
      "active": [...],
      "rawResults": "positional array aligned with active"
    }
  }
}
```

### Conductor instructions (reusable prompt)

```
You are a workflow conductor. You receive a workflow config with N workers.

1. Spawn ALL workers IN PARALLEL via the Agent tool. Each worker gets its `prompt`
   and must return StructuredOutput matching its `schema`. Label each agent
   "worker:<key>" so you can map results back.

2. Collect every worker's StructuredOutput. A worker that fails or returns no
   valid output → null in that position.

3. Build the raw JSON as specified by `merge.rawJsonSchema`. Write it to a temp
   file with the Write tool.

4. Run `merge.command` via PowerShell/Bash. Return its output as your final
   response.

NEVER merge, deduplicate, or assign IDs yourself. The merge command owns that.
```

### Why the merge stays external

The merge (dedup, ID assignment, confidence tagging, markdown rendering) is deterministic
math — running it in AI is both wasteful and non-deterministic. Keeping it in `.mjs` files
(`lib.mjs` → `post-review.js`) means:
- Byte-identical output regardless of which model runs the conductor
- Testable independently of any AI call
- Shared between main-loop Workflow path and subagent conductor path

## Sharp-review concrete changes

If we adopt Pattern A for sharp-review:

1. **New file**: `skills/sharp-review/reference/conductor-pattern.md` — the reusable
   conductor prompt template with placeholders for workers/schema/merge command.

2. **SKILL.md Step 3b**: Replace the inlined fan-out instructions with a reference to
   the conductor pattern and the concrete workflow config for this profile.

3. **`sharp-review-workflow.js`**: Unchanged — it remains the canonical orchestration
   definition for the Workflow VM path (3a). The conductor path (3b) uses the same
   merge layer (post-review.js) but a different fan-out mechanism (Agent tool vs
   workflow VM's `agent()`).

## Open questions

1. **Error recovery**: The Workflow VM's `parallel()` silently returns null for failed
   agents. A conductor subagent has no equivalent — if one Agent call fails mid-way, the
   conductor must decide whether to proceed with partial results or abort. The SKILL.md
   instructions should be explicit about this.

2. **Seed rotation determinism**: The Workflow script uses `seed mod 3` to pick reviewers.
   In the conductor pattern, the caller (SKILL.md) does the mod math and passes only the
   active reviewers. This is simpler but means the rotation logic lives in the skill, not
   the workflow — two places to keep in sync.

3. **StructuredOutput availability**: The conductor pattern depends on `Agent` tool +
   `StructuredOutput`. On Codex (which has `spawn_agent` but may not support
   StructuredOutput the same way), the takeover MCP path is the fallback — the conductor
   must handle both. This is already the case in Step 3b.

4. **Nested conductors?** If a worker agent is itself a conductor (spawning sub-workers),
   we're back to the nesting problem. Rule: a conductor may only spawn leaf workers, never
   nested conductors. Enforce by convention in the conductor prompt template.
