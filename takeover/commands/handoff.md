---
description: Summarize the current conversation and hand off to another AI model
argument-hint: "[--provider <name>] [--model <model>] [instruction for the next agent]"
allowed-tools: Agent
---

Your task: synthesize the current conversation into a structured handoff summary, then invoke the takeover agent to pass it to another model.

## Step 1 — Summarize the conversation

Extract from this session's context:

- **Goal**: What are we trying to accomplish? (1 sentence)
- **Progress**: What's been done so far? (bullet points, concrete — files changed, decisions made)
- **Current state**: Where exactly are we right now? What's the latest finding or blocker?
- **Key decisions & rationale**: Non-obvious choices made and why.
- **Unresolved questions**: What's still open or needs investigation?
- **Next steps**: What should happen next?

Keep the summary tight — the target model needs context, not a transcript.

## Step 2 — Hand off

Invoke the `takeover:takeover` subagent via `Agent` (`subagent_type: "takeover:takeover"`), forwarding:

```
[mode:handoff]

<handoff>
[Your structured summary from Step 1]
</handoff>

<task>
$ARGUMENTS
</task>
```

The takeover agent will route this to the target model with the handoff system prompt.

## Execution rules
- Default to foreground execution.
- Default provider is `deepseek` unless the user specifies `--provider <name>`.
- Return the agent output verbatim — no paraphrasing, no commentary.
- If the user did not supply a task instruction, ask what the next agent should do.
