# Sharp Review — Fan-out and result recording (reference)

On-demand detail for SKILL.md Step 2: how the worker (Claude Code subagent or Codex worker)
calls each planned reviewer and what it records. The plan already decided WHO reviews WHAT on
WHICH provider; the worker only executes it.

## Calling a reviewer

**Primary: `mcp__plugin_fabric_fabric__call`** with the plan's `provider`, `model` (only when
the plan gives one), `mode=<call_mode>`, `resultMode="full"`, `prompt=<prompt>`. The worker
agent must list `mcp__plugin_fabric_fabric__call` and `..._list_providers` in its `tools:`
allowlist, or every call silently falls through to the fallback.

**Fallback:** the `Agent` tool (Claude Code) / `spawn_agent` (Codex), one per reviewer, only
when the fabric tool is absent. The reviewer's `provider` is still the one the plan named; if
the host cannot run it, record it as unavailable (below) — never substitute another provider.

## Recording one result per reviewer

`raw-<run_id>.json` is `{ "run_id": "<plan run_id>", "results": [ ... ] }`, one entry per
reviewer the plan marked `pending`, keyed by the plan's reviewer `name`:

| what came back | record |
|---|---|
| JSON `{ "findings": [...] }` (Anthropic-compatible providers) | `{ "name", "findings": [...] }` — `[]` is a clean pass |
| codex review-mode prose with issues | `{ "name", "findings": [...] }` normalized per § Codex prose |
| codex reply that is only the `(no findings ...)` placeholder | `{ "name", "text": "<the reply>" }`, plus `"error_kind"` when fabric reported one |
| the call failed and fabric named a kind | `{ "name", "error_kind": "exhausted" \| "auth" \| "rate_limit" \| "timeout" \| "unsupported", "error": "<its error text>" }` |
| failed with no kind, empty, truncated, off-topic, unparseable | `{ "name" }` (no findings), plus `"error"` when the call reported one |

A reviewer left out of `results` is recorded as `unavailable`. post-review.js maps each entry
to a reviewer status by the method's `reviewer_status` rules; the worker never writes a status
itself and never turns an ambiguous reply into `[]`. A failed call's `"error"` text (never a key)
is copied into the reviewer's `error`; a failed reviewer without one gets the method's reason for
its status (`reviewer_status.error`).

## Codex prose

Codex `mode="review"` uses its native review endpoint, which ignores the JSON instruction and
returns prose. Parse each issue it raises into `{ severity, file, summary, category,
suggestion, detail, principles }` as the finding schema in the prompt defines; do not invent a
`file`, a severity or a principle id the prose does not support. post-review.js drops any entry failing the schema and
counts it on the reviewer (`dropped_findings`).

A codex reply that is only `(no findings ...)` is NOT a clean pass — on a quota, auth or failed
turn codex returns exactly that placeholder. Record it as `text` (above); it becomes the failure
kind fabric reported, else `unavailable`. Only an affirmative statement that the change has no
material issues is a clean `[]`.

On Windows: write the raw file with the Write tool, not Bash redirection.
