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
