---
name: worker-fanout-tool-and-codex-prose
description: sharp-review worker FAILED all reviewers because its tools allowlist omitted the takeover MCP tool; also codex review-mode returns prose not JSON
metadata:
  type: project
---

# Worker fan-out tool gap + codex review-mode prose

Two bugs behind `0/2 reviewers succeeded` (all reviewers FAILED across both diff and docs runs, 2026-06-29):

## 1. Missing takeover MCP tool (root cause)

`agents/sharp-review.md` frontmatter declared an explicit `tools:` allowlist
(`Bash, PowerShell, Read, Write, Agent, Glob, Grep`). In Claude Code an explicit list is
**exhaustive** — the worker never received `mcp__plugin_takeover_takeover__call_model`, the
documented *primary* fan-out path. So every reviewer silently fell back to the `Agent` tool
(safety-classifier path the skill flags as flaky), and when all reviewers funnel through it
you get a full-roster failure — independent of provider health (live: claude→OK,
deepseek→clean JSON, codex authenticated v0.142.3).

**Fix:** added `mcp__plugin_takeover_takeover__call_model, mcp__plugin_takeover_takeover__list_models`
to the agent's `tools:` line. **Lesson:** any agent that needs an MCP tool MUST list it
explicitly in `tools:`; an allowlist excludes everything not named.

## 2. Codex review-mode returns prose, not JSON

`provider="codex", mode="review"` uses codex's native review endpoint, which ignores the
"respond with ONLY `{ "findings": [...] }`" instruction and returns prose. This makes reviewer
A fail JSON extraction on its own. Chosen resolution (over switching codex to `mode="task"`):
keep review mode, have the **worker parse the prose into the findings schema** itself.
Documented in `agents/sharp-review.md` Step 3 and `skills/sharp-review/reference/direct-fanout.md`
— a reviewer is `null` ONLY on takeover error/empty output, not on prose.
