---
name: system-prompt-platform
description: Self-maintained system-prompt platform — GLOBAL-AGENTS.md owns principles, claude-base.md/codex-base.md platform layers, discover-styles/build/sync-official tooling, toolsPreset tiers
created: 2026-08-09
tags: [system-prompt, cache, styles, codex, cost]
---

# System-prompt platform (2026-08-09, Sync/claude + fabric)

Every non-native path (fabric providers incl. codex) uses a self-maintained
system prompt; native `claude` keeps the official one. Verified via claude-tap
(vanilla api.anthropic.com, haiku 4.5) — full data in cc-lab
`reports/system-prompt-platform.md` (research lives there; this entry is the
fabric-side iteration record).

## Files (Sync/claude/)
- `GLOBAL-AGENTS.md` (~500 tok, symlinked from `~/.claude/CLAUDE.md` AND
  `~/.codex/AGENTS.md`): ALL universal principles + prefs — first principles,
  delivery scope, analysis-first, safety, correction, language, code style,
  LSP, TDD, communication (concise, no emojis, file:line), git (heredoc/
  force-with-lease/tests/retry 3×), rem memory + todos.
- `system-prompt/claude-base.md` (~330 tok, one line per bullet): claude
  platform specifics — tool-preset discipline (removed tools named absent:
  Task/Cron/NotebookEdit/DesignSync/RemoteTrigger/ReportFindings/PowerShell/
  Workflow/SendUserMessage), delegation (subagents/fork/SendMessage),
  PushNotification discipline.
- `system-prompt/codex-base.md` (~300 tok): codex platform — shell/apply_patch
  discipline, single-execution process, approval waits. Wired via
  codex_config.toml (gitignored) `model_instructions_file`; no cross-process
  cache on codex (tokens used constant across identical runs).
- `system-prompt/discover-styles.mjs`: official-style lookup (user → project
  cwd→root, nearest wins) + `STYLE_SEARCH_DIRS` extra dirs; parses frontmatter;
  never moves existing config.
- `system-prompt/build.mjs`: claude-base + style body → `dist/<style>.claude.md`
  + styles.json; static validation (no cwd/env/gitStatus/time leaks).
- `system-prompt/sync-official.mjs`: Piebald extraction diff radar → absorption
  list in CHANGELOG.md (first run = full baseline; later = parts newer than
  last checked version). Human decision, never auto-merged.

## Verified mechanics
1. `--system-prompt "<static>"` = cache key: first process create 6,379; next
   reads 25,752 / creates 0; different prompt → 19,373+6,379. Request =
   system[billing][base][static] + user[CLAUDE.md ~4.3k][prompt+cache_control]
   + tools ~33.6k. `--append-system-prompt` useless (past unstable tail).
2. output-style does NOT inject under `--system-prompt` → styles live inside
   our prompt files.
3. codex `model_instructions_file` replaces built-in base (marker verified);
   AGENTS.md appends on top.
4. official `--exclude-dynamic-system-prompt-sections` = Anthropic's own fix
   for the unstable tail (cwd/env/gitStatus) — ignored with --system-prompt.
5. Injection ~42.3k = tools schema 33.6k (80%) + system 4.3k + CLAUDE.md 4.3k.
   `--tools <subset>` trims schema (−76% with 6 tools); `--allowedTools` does
   not.

## toolsPreset (fabric, commit 7e9c0f4)
`fabric.profiles.*.toolsPreset` → `--tools`: exec (6, 6.1k tok) / coord (8,
7.7k, no writes) / daily (16, 16.4k, default) / full (no flag, 33.6k). `--tools`
added to PROFILE_OWNED_FLAGS. codex has NO equivalent (fixed tool set).

## User constraints
- All non-native paths default to the custom prompt; native claude keeps
  official. Styles switchable (coding/academic/post + extensible via any
  output-styles dir). Background/subagent/team sections user-reviewing —
  untouched. Iteration memory lives HERE (cc-market/fabric), not cc-lab.

## 2026-08-09 follow-up (commits da99840 + ae21c84)
- fabric auto-injects --system-prompt-file: `fabric.systemPromptFile` config
  default (both openSession + spawnChild paths); profile.systemPromptFile
  overrides; flag is profile-owned. User default → claude-base.md. With
  toolsPreset = complete cost chain.
- codex 3-layer injection VERIFIED (markers): L1 model_instructions_file ✓
  L2 ~/.codex/AGENTS.md (GLOBAL symlink) ✓ L3 project CLAUDE.md fallback ✓.
  Path gotcha: model_instructions_file must be FORWARD slashes (backslashes
  silently ignored via -c override).

## 2026-08-09 iteration complete (commits b7bcd19/0807b30/cb8e6ae)
- profile.style → dist auto-build (style-resolve.mjs, stale = style source
  newer; rebuild via build.mjs). Priority: profile.systemPromptFile >
  profile.style > fabric.systemPromptFile. Both spawn paths.
- exclude-dynamic-system-prompt-sections: flag works on default prompt
  (create 46,147 → 9,646, system 36,420 shared-hit) but the settings.json
  field is IGNORED — native TUI keeps official prompt; fabric path doesn't
  need it (full replace).
- validate-cache.mjs: two-run usage check — claude-base.md healthy (15,600
  read / 0 create). --tools=<list> equals form required when a prompt follows
  on argv (separate-arg form mis-parses); fabric stdin spawns immune.
- Sync/claude npm test now includes system-prompt tests (34 pass).

## 2026-08-10 systematic cleanup (committed)
Instruction layering unified across all three fabric paths — system layer
(platform, persistent) vs per-call layer (mode template + customSystem + user
prompt, user message) vs project layer. Changes:
- prompts/task.md de-duplicated against GLOBAL (removed "Complete the task
  fully"/"be concise"/"idiomatic code" — GLOBAL owns those); review.md kept
  (adversarial stance is mode-specific).
- mcp-server.mjs: mode template prepended to userPrompt on EVERY provider
  (was: API→body.system, claude/codex→user message — inconsistent); systemPrompt
  var now = customSystem only.
- API providers (deepseek/kimi direct-connect) now get the platform prompt:
  callAnthropicAPI reads fabric.systemPromptFile → body.system (was missing
  entirely — the "all non-native paths get the custom prompt" gap).
- Guard test prompts-overlap.test.mjs: mode templates must not restate GLOBAL
  phrases (fails future dual-source edits). 317 fabric tests pass.
