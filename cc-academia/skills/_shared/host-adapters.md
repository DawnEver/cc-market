# Host adapters

The playbooks are written host-neutral. Where Claude Code and Codex genuinely
differ, the difference is named here and nowhere else, so a playbook says
"dispatch a subagent" rather than picking a tool name.

## Subagents

| Capability | Claude Code | Codex |
|------------|-------------|-------|
| Named subagent | `Agent` tool with `subagent_type` | collaboration agent from `agents/` |
| Parallel fan-out | multiple `Agent` calls in one message | multiple collaboration agents |
| External model | `fabric` plugin (`mcp__plugin_fabric_fabric__call`) | `fabric` plugin, same tools |

Agent definitions in `agents/` are read by both hosts. Names are prefixed by
workflow — `literature-*`, `manuscript-*`, `discovery-*` — because all three
workflows ship in one plugin and a collision would silently route work to the
wrong reviewer.

## Background work

| Capability | Claude Code | Codex |
|------------|-------------|-------|
| Long-running command | `run_in_background`, notification on exit | run it in the foreground, or a detached shell |

Acquisition is the only step long enough to care. If the host cannot background
it, run it with a smaller `--limit` and repeat; the ledger makes the work
resumable, so nothing is lost or repeated.

## File permissions

| Capability | Claude Code | Codex |
|------------|-------------|-------|
| Deny reading a path | `settings.json` permissions + `hooks/` | not guaranteed |

This is why manuscript confidentiality is enforced **inside the CLI**: the tools
never print manuscript body text, only `sanitized.json`. The Claude-side hook is
a second lock, not the only one. Never rely on a host permission alone for a
confidentiality guarantee.

## AI backends

Deep reading, synthesis and abstract screening call a model. Both hosts reach it
the same way: the `fabric` plugin first, `litellm` through the `ai` extra as a
fallback. **Confirm the backend and model with the user before each run** — cost
and quality differ enough that silently picking one is not acceptable.
