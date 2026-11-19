---
name: agy-support
description: Antigravity (agy) plugin support — gen-agy.mjs generated artifacts, hook-facts agy helpers, commands/->claude-commands/, validate allow-list
metadata:
  type: project
---

# Antigravity support (2026-11-19)

## Generated artifacts (`node scripts/gen-agy.mjs`, drift-checked by `tests/gen-agy.test.mjs`)
- `<plugin>/.antigravity-plugin/plugin.json` — name, version, author, homepage, repository; `disabled: true` for watch / cc-latex / cc-academia; `skills: "./agy-skills/"` when the plugin has commands.
- `<plugin>/hooks.json` (ROOT — agy reads only that for native plugins) — named hook per plugin, `node ./hooks/x.js --host agy`. Events: PreToolUse matchers mapped (`CLAUDE_TO_AGY_TOOLS` in shared/hook-facts.mjs), UserPromptSubmit -> PreInvocation, PostCompact dropped, SessionStart/Stop kept.
- `<plugin>/mcp_config.json` — `.mcp.json` with relative paths + `cwd: "."`.
- `<plugin>/agy-skills/<cmd>/SKILL.md` — one skill per Claude command (agy plugins have no commands). The manifest `skills` path is loaded IN ADDITION to `skills/`, so Claude/Codex never see these. Name collides with a real skill -> `-command` suffix (watch).
- Agents need nothing: agy loads `agents/*.md` natively.

## Source-layout changes forced by agy's validator
- `commands/` -> `claude-commands/` (a `commands/` dir is an agy warning); Claude manifests point there.
- Agent `tools:` comma-strings -> YAML lists (agy errors on strings; Claude documents both). `model: sonnet` -> `model: inherit` (agy rejects Claude tiers): the cc-academia reviewers now run on the session model in Claude too.
- `agy plugin validate --strict` cannot pass on the shared layout: per-plugin AGENTS.md, `hooks/hooks.json`, `.mcp.json` stay as warnings. The test asserts 0 errors and only those warnings.

## Hook runtime (shared/hook-facts.mjs)
- `isAgyHost` (`--host agy`, camelCase payload keys, `ANTIGRAVITY_CONVERSATION_ID` / `ANTIGRAVITY_AGENT=1`, or `PLUGIN_ROOT` without `CLAUDE_PLUGIN_ROOT`), `normalizeHookInput` (toolCall -> tool_name/tool_input with Claude names/arg keys, cwd = workspacePaths[0], `<USER_REQUEST>` envelope stripped from `lastUserInput`, continuationActive -> stop_hook_active, fullyIdle:false -> background_tasks), `hookSessionKey` = conversationId || ANTIGRAVITY_CONVERSATION_ID, agy transcript steps (USER_INPUT / PLANNER_RESPONSE.tool_calls, double-encoded args) in `normalizeHookFacts`.
- `SESSION_ENV` in `rem/scripts/tasks.mjs` includes `ANTIGRAVITY_CONVERSATION_ID` so `task.js` resolves the session's bound task inside Antigravity child shells.
- `hookOutput` / `emitHookOutput`: agy deny `{decision:"deny"}`, PreToolUse allow `{decision:"ask"}`, Stop block `{decision:"continue",reason}` exit 0 (nothing when continuationActive), context `injectSteps[systemMessage]`; agy always gets a JSON object (`{}`).
- PreInvocation (`rem/hooks/user-prompt.js`) fires before every model call: handlers act only when `isFirstInvocation` (invocationNum absent/0).
- Stop hooks act only on `terminationReason === "NO_TOOL_CALL"`.
