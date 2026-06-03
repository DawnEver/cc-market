---
description: Hand off a planning request to another AI model — let it take over and produce the implementation plan
argument-hint: "[--provider <name>] [--model <model>] [what to plan]"
allowed-tools: Agent
---

Invoke the `takeover:takeover` subagent via the `Agent` tool (`subagent_type: "takeover:takeover"`), forwarding the raw user request as the prompt prefixed with `[mode:plan] `.

The subagent calls the target model via the `call_model` MCP tool and returns its output verbatim.

Raw user request:
$ARGUMENTS

Execution rules:
- Default to foreground execution.
- Default provider is `deepseek` unless the user specifies `--provider <name>`.
- Return the agent output verbatim — no paraphrasing, no commentary.
- If the user did not supply a request, ask what should be planned.
