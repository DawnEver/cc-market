# Stop Hook Pending-Work Guard

`rem-hook.js` computes `hasPendingWork = background_tasks.length > 0 || now < taskActiveUntil`
before the deny gate, and skips advancing state when true — prevents mid-flight
interruption of sharp-review/takeover/codex workflows and sequential multi-round skills.

- `background_tasks`: async subagents — provided by Claude Code in hook input.
- `taskActiveUntil` (`state.hook.taskActiveUntil`, epoch ms): for skills that run multiple
  sequential rounds in a single turn with no background tasks. Set to `Date.now() + 30*60*1000`
  at the start of such a skill via `loadState()`/`saveState()`, and `delete` it (or let it
  expire) when done. Auto-expires after 30 min even if the skill crashes.

Any new multi-round skill MUST set `taskActiveUntil` if it doesn't spawn background tasks,
or the Stop hook may fire mid-skill.
