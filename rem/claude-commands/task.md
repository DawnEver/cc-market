---
description: Open or close a task — the user's command (refused by default for an agent) — rem's tasks layer
argument-hint: open <slug> "<goal>" [--scope <paths>] [--owner <who>] | close <slug> ["<reason>"] [--journal-only D<n>,...]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" $ARGUMENTS`

Show the user the output above verbatim. Do not run `task.js open` or `task.js close` yourself:
without this command's authority record it is refused, and a workaround is detected by
scope-validate. Every other verb: `task.js help`; the mechanism: `skills/rem/reference/tasks.md`.
