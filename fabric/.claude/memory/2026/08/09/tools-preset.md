---
name: tools-preset
description: toolsPreset role tiers (exec/coord/daily/full) map to --tools schema trimming — measured token sizes, profile wiring, codex has no equivalent
created: 2026-08-09
tags: [tools, profile, cost, cache, codex]
---

# toolsPreset role tiers (2026-08-09)

`fabric.profiles.*.toolsPreset` → `--tools` at spawn (schema trimming = cost
lever, NOT permission — `--allowedTools` stays the permission control).
Implemented in `engine/profile.mjs` (commit 7e9c0f4), tested 311 pass.

| preset | tools | schema | role |
|--------|-------|--------|------|
| exec | Bash,Read,Write,Edit,Glob,Grep | ~6,076 tok | execution-only |
| coord | Read,Glob,Grep,Bash,SendMessage,PushNotification,WebFetch,WebSearch | ~7,674 tok | dispatch/verify/notify, no writes |
| daily | exec + Skill,Agent,EnterWorktree,ExitWorktree,Monitor,ScheduleWakeup,WebFetch,WebSearch,SendMessage,PushNotification | ~16,436 tok | everyday (default) |
| full | (no --tools) | ~33,600 tok | all 31 built-ins |

Measured via claude-tap on 2.1.226 (31 built-in defs = 119.5k chars ≈ 33.6k tok;
Workflow 21.3k / Bash 11.7k / PowerShell 9.2k / DesignSync 8.9k / Agent 8.8k are
the biggest). `--tools <subset>` verified: 6 tools → 21 defs (6 + 15 fabric MCP
auto-attached) ≈ 8k tok (−76%). `--allowedTools` does NOT shrink the schema.

Profile wiring: `--tools` added to PROFILE_OWNED_FLAGS; profileArgs appends
`--tools <preset list>`; extraArgs cannot override (stripped + flags last).

## Notes
- codex has NO equivalent: tool set fixed (shell/apply_patch/web_search), no
  --tools/schema trimming. codex "tiers" would be behavior-level (different
  model_instructions_file variants); single codex-base.md suffices today.
- Cost interplay: with a static `--system-prompt-file` (claude-base.md),
  trimmed tools + stable system → full cross-process cache hits on claude
  (run 2: 50,848 read / 354 create).
- User constraints: every non-native path defaults to custom system prompt
  (styles switchable); native claude keeps official; E group (background/
  subagent/team) user-reviewing, untouched.
