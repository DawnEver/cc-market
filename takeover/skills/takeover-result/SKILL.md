---
name: takeover-result
description: Internal guidance for presenting takeover companion output back to the user
---

# Takeover Result Handling

## Output Rules

- Return the companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not fix or apply any suggestions from the output unless explicitly asked.
- If the companion fails (non-zero exit, error on stderr), report the error clearly and suggest checking provider configuration in `~/.claude/claude_env_settings.json`.

## Presenting Results

- The companion output is the final response.
- For task results: present the full output including any findings, code, or analysis.
- For plan results: present the full plan structure as-is.
- Do not interleave your own analysis with the handed-off model's output.
