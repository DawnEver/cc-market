---
name: sharp-review
description: Post-feature sharp review (锐评) —parallel reviewers, merge findings, sync task list
---

# Sharp Review (锐评)

Post-feature review: each run picks review profiles, gives each to a reviewer on a provider,
and merges their schema-bound findings into one memory entry
`.claude/memory/YYYY/MM/DD/sharp-review.md`. The METHOD (profiles, prompts, finding schema,
status and merge rules) is data in `<root>/method/`; the scripts only execute it. Normally
invoked by the Stop hook (Wave Gate); `/sharp-review` runs it manually. Gate, profile and
config detail → **`reference/profiles-and-modes.md`**.

## Execution mode (read first)

Review runs on git state, not the conversation, so the main loop **dispatches one
`sharp-review:sharp-review` subagent** (Codex: built-in `worker` told to use this skill)
to run Steps 0–4 and return only the `Sharp review: <summary>` line. Pass the hook's
`firedSources`, plugin root and `gateToken`, when supplied. The worker fans out
reviewers itself and must not re-dispatch.

## Execution

### Step 0 — Plugin root

`<root>` is the absolute plugin root: the `plugin root:` the dispatch instruction names (the
Stop hook resolves and checks it), else `$CLAUDE_PLUGIN_ROOT`, else two directories above this
`SKILL.md` (`<root>/skills/sharp-review/SKILL.md`). It must contain `method/method.json`; if it
does not, report `Sharp review: plugin root not found` and stop.

### Step 1 — Plan

Call `mcp__plugin_fabric_fabric__list_providers` and pass its provider keys as `--available`:

```powershell
node "<root>/scripts/plan.js" --sources <firedSources> --available <key1,key2,...>
```

For a hook-triggered run, add `--gate-token <gateToken>` exactly as dispatched. The plan
carries this token to `post-review.js`; only a persisted run with a successful reviewer
credits the source hashes. Do not invent a token for manual runs. If Fabric is unavailable
or the run fails before post-review, release the claim with:

```powershell
node "<root>/scripts/post-review.js" --release-gate <gateToken>
```

Release is not completion. A plan with no runnable reviewers releases automatically. A
crashed worker's claim expires after 30 minutes; the Stop hook never loops indefinitely.

Options: `--providers <a,b>` requests a provider set instead of the rotation (a requested
provider that is not available is planned `unavailable`, never replaced); `--profile <key>`
forces one profile; `--range "main...HEAD"` / `--path <dir>` scope
the diff (default: uncommitted changes vs HEAD). Never run raw `git diff` or paste diff text —
the plan carries the diff inside each prompt. Capture the plan JSON: `run_id`, `plan_file`,
`profiles`, and `reviewers: [{ name, provider, status, call_mode, model?, prompt }]`.

If no reviewer has `status: "pending"`, report `Sharp review skipped: <statuses>
(<excludedSummary>)` and stop.

### Step 2 — Fan out

For every reviewer with `status: "pending"`, call `mcp__plugin_fabric_fabric__call` with
`provider=<provider>`, `model=<model>` (only when present), `mode=<call_mode>`,
`resultMode="full"` (REQUIRED — the default `"summary"` truncates), `prompt=<prompt>`. Never
replace a reviewer's provider with another one. Record one result per reviewer exactly as
**`reference/direct-fanout.md`** specifies (findings, codex prose, failure kinds).

### Step 3 — Merge and write

Write `{ "run_id": "<run_id>", "results": [...] }` with the Write tool (never Bash redirection
on Windows) next to the plan as `raw-<run_id>.json`, then:

```powershell
node "<root>/scripts/post-review.js" --plan "<plan_file>" --raw "<raw file>"
```

(`--sink stdout` prints the findings JSON instead of writing memory —
the contract, with its field and status meanings, is `<root>/method/findings-output.schema.json`.)

It refuses a raw file whose `run_id` is not the plan's or that is older than the run, then
merges by the method's rules, writes `.claude/memory/YYYY/MM/DD/sharp-review.md`, stamps
`.claude/rules/MEMORY.md`, and prints the summary line. Do NOT merge or assign `SR-` ids
yourself. If it errors, report the error and stop.

### Step 4 — Report

Output in chat ONLY the `Sharp review: <summary>` line. Findings go to the backlog, not chat.
Only when a human asks to **triage now** route OPEN findings through `shared/attention.mjs` —
→ `reference/profiles-and-modes.md` § Attention boundary.

## Resolving findings

`todo mark <SR-ID> fixed` flips `**Status:**` and re-derives the frontmatter (same as
`post-review.js --rescan --date <YYYY-MM-DD>`). File ownership → `reference/task-system.md`.

## Phase 2 — Task Audit

1. Run `todo` — review open findings against code changed this session (`⚠ likely-resolved`).
2. For each finding you fixed AND verified this session, `todo mark <SR-ID> fixed` now.
3. Flag stale items (> 90d) — `todo` shows `⚠ stale`.
4. Check in-flight tasks with the host's available task/agent status tools before calling
   a feature complete; do not assume Claude's `TaskGet` exists on Codex.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed.
