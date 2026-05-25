---
description: Use another AI model to plan an implementation approach
argument-hint: "[--provider <name>] [--model <model>] [what to plan]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Plan an implementation approach using another AI model via the ai-companion runtime.

Raw user request:
$ARGUMENTS

Execution:
- Extract `--provider` and `--model` values from `$ARGUMENTS` for the command line. All remaining text (the prompt) goes exclusively into the heredoc body. Never put prompt text on the shell command line.
- The command line carries only structured flags; the quoted heredoc carries the full prompt safely:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" plan --provider <name> [--model <name>] <<'PROMPT'
  <prompt text only>
  PROMPT
  ```
- `<<'PROMPT'` (quoted) prevents all shell expansion in the heredoc body.
- The ai-companion reads stdin first for the prompt (stdin overrides argv).
- Default provider is `deepseek` unless the user specified another.
- Return the plan output verbatim to the user.
- If no prompt is provided, ask the user what they want to plan.
