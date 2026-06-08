---
description: Internal skill for presenting Codex image generation output
user-invocable: false
---

# Codex Image Result Handling

When presenting image generation/editing results to the user:

1. Show the `SAVED:` paths prominently — these are the generated images.
2. If the output contains image descriptions or metadata, present it after the paths.
3. If no `SAVED:` lines are present but stdout looks like a successful generation, show the output as-is.
4. On error, report clearly and suggest checking `codex login` status.
5. Do not re-run image generation unless the user explicitly asks.
