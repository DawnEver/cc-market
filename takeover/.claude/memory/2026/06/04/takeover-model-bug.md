---
name: takeover-model-bug
description: takeover MCP call_model always passes model="sonnet" regardless of --provider — blocks DeepSeek/Claude takeover reviewers
metadata:
  type: project
created: 2026-06-04
accessed: 2026-06-04
tier: short
---

# Takeover Plugin Model Bug

`mcp__plugin_takeover_takeover__call_model` always sends `model: "sonnet"` to the remote API, ignoring the `provider` and `model` parameters.

## Reproduction
- `/takeover:continue --provider deepseek --model deepseek-v4-pro` → API Error: "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed sonnet"
- `/takeover:continue --provider claude` → same error (model="sonnet" sent to DeepSeek)

## Impact
- Blocks sharp review: both Reviewer B (DeepSeek takeover) and Reviewer C (Claude takeover) fail
- Only Codex adversarial-review works as external reviewer
- Sharp review effectively runs with 0–1 reviewers instead of the required 2–3

## Likely Root Cause
In `cc-market/takeover/lib.mjs` or `mcp-server.mjs` — model selection doesn't respect the provider context. The MCP tool's `call_model` implementation hardcodes or defaults to "sonnet".

## Discovered
2026-06-04 during sharp review of commit 5e9506b. Both takeover reviewers failed identically.
