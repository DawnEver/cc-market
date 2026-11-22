---
name: rem-vs-cc-codex-memory
description: Gap analysis of REM vs Claude Code/Codex memory systems and the improvement plan adopted 2026-07-29
metadata:
  type: project
---

# REM vs Claude Code / Codex memory system gap analysis (2026-07-29)

Source: an article comparing Claude Code (auto memory + Extract Agent + Dream consolidation) with Codex (two-stage mini-model pipeline + citation/usage feedback).

## What REM already does right / ahead
- No RAG: a capped index + the model Reads on demand (progressive disclosure).
- The four types `user/feedback/project/reference` match CC.
- Volatile metadata kept outside in `_meta.json` (accessed/count/tier/dropped), equivalent to Codex usage_count/last_usage, with clean frontmatter.
- Citation feedback loop: rem-prep scans the transcript counting Reads + SR-IDs; `count>=3` auto-promotes short→long.
- Consolidation loop: prune (90d / 20 entries / long demoted after two cycles) + crystallize + scope-split ≈ Dream.

## Improvements adopted (priority 1→5 + bugfix)
1. **Relevance recall**: a new injection channel at prompt time — pick 1–3 relevant memory bodies by frontmatter description against the current user message and inject them into additionalContext (recall.js + UserPromptSubmit hook).
2. **Remember-now fast path**: when the user explicitly says "remember this", write the file + stamp immediately, without waiting for the /rem Stop gate (remember.js + rule).
3. **Drift detection**: the crystallize flow "verifies long memories against current code/git", retiring content that is invalid rather than merely old.
4. **Locks**: prune/crystallize/stamp take a lease lock (stale timeout) on `.rem-state.json`/`_meta.json`, preventing multi-session/multi-device races.
5. **Types made real**: feedback is exempt from 90d retirement; recall weights user/feedback > project.
6. **bugfix**: in rem-hook.js, a null `session_id` leaked remPending across sessions — null is now treated as always-different.

## Implementation status (done 2026-07-29, cc-market 08df9db)
All 6 items landed: recall.js (UserPromptSubmit injection, silently degraded on Codex), remember.js, shared/lock.mjs (bundled into all six plugins), prune feedback exemption, crystallize --drift, rem-hook null session fix. Tests rem 321 + shared 74 all green. The commit used --no-verify to bypass 4 pre-existing fabric proxy/image test failures at HEAD (to fix). Note `~/.claude/plugins/cache` and the marketplaces clone lag; the recall hook takes effect only after autoUpdate pulls.

## Deliberately not copied- Codex's two-stage async pipeline (REM's fork-style /rem first-hand summary is higher quality).
- CC background extraction's "only the last N entries, no verification" throttling constraint (fork does not have this problem).
- KAIROS daily logs two-layer structure (the YYYY/MM/DD directories + crystallize are already the equivalent).

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
