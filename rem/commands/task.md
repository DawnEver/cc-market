---
description: Open or close a task — the user's command (refused by default for an agent) — rem's tasks layer
argument-hint: open <slug> "<goal>" [--scope <paths>] | close <slug> ["<reason>"]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" $ARGUMENTS`

Show the user the output above verbatim. If it opened a task, the session that works on it
binds by `--task <slug>` or by a worktree/branch named after it, and records progress only
through `task.js log|decide|open-item|close-item|handoff`. Do not run `task.js open` or
`task.js close` yourself: without this command's authority record it is refused, and a
workaround is detected by scope-validate.
