---
description: Hand off a task or investigation to another AI model — let it take over and return the result
argument-hint: "[--provider <name>] [--model <model>] [what to hand off]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `takeover:takeover` subagent via the `Agent` tool (`subagent_type: "takeover:takeover"`), forwarding the raw user request as the prompt.

The subagent hands off the request to the companion script, which calls the target model and returns its output verbatim.

Raw user request:
$ARGUMENTS

Execution rules:
- Default to foreground execution.
- Default provider is `deepseek` unless the user specifies `--provider <name>`.
- Return the agent output verbatim — no paraphrasing, no commentary.
- If the user did not supply a request, ask what should be handed off.
