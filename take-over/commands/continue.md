---
description: Delegate a task or investigation to another AI model for a second opinion
argument-hint: "[--provider <name>] [--model <model>] [what to investigate or fix]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `take-over:ai-continue` subagent via the `Agent` tool (`subagent_type: "take-over:ai-continue"`), forwarding the raw user request as the prompt.

The subagent (a thin forwarding wrapper) will call ai-companion via Bash with the prompt text on stdin and flags on the command line.

Raw user request:
$ARGUMENTS

Execution rules:
- Default to foreground execution.
- Default provider is `deepseek` unless the user specifies `--provider <name>`.
- Do not paraphrase, summarize, or add commentary around the agent output. Return it verbatim.
- If the user did not supply a request, ask what should be investigated or fixed.
