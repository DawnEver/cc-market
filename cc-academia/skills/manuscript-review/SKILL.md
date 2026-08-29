---
name: manuscript-review
description: Review an academic paper PDF — ingest, summarise, fan out multi-angle 锐评, polish user draft into publishable English reviewer comments, archive.
allowed-tools: "Read,Write,Bash,Glob,Grep,Agent,Skill,WebFetch,WebSearch,Workflow"
---

# /manuscript-review:new — Review a paper

Running the CLI: `_shared/running-the-cli.md`. Host differences:
`_shared/host-adapters.md`.

## Host execution rule

This directory and linked `.claude/workflows/` and `.claude/agents/` files are the single source of truth. Claude Code may invoke native `Workflow` and `Agent` runtimes. Codex reads those same specifications and uses the host-adaptive paths in steps 02, 04 and 07 (collaboration subagents, web search, and `mcp__fabric__call` / `mcp__fabric__fan_out` when available). Never duplicate their prompts in `.agents/skills`.

You are the orchestrator. Given a PDF path (or a slug already in `ongoing/`), walk the pipeline below in order.

## Review voice

If the `Review` output style has not already been injected by the host (Claude settings or a Codex custom system prompt), read `.claude/output-styles/Review.md` before producing reviewer-facing prose. Do not re-read or duplicate it when it is already active. `style/profile.md` remains the authoritative learned voice as specified there.

## Pipeline

| Step | File | What happens |
|------|------|--------------|
| 0 | `00-language.md` | ⭐ Pick intermediate-file language (default English, switchable to Chinese) → `review-config.md` |
| 1 | `01-ingest.md` | marker-pdf → `1-paper-text/paper.md` + `md/` + `img/sec*` + `INDEX.md` |
| 2 | `02-literature.md` | Invoke workflow `manuscript-review-literature` — parallel extraction + IEEE search + author profiling |
| 2b | `02b-consensus.md` | ⭐ Write `2-review/summary.md` — shared truth (folds in literature, + venue type + `Obvious gaps`), user confirms |
| 3 | `03-angle-gate.md` | ⭐ Propose angles, user confirms |
| 4 | `04-fanout.md` | Invoke workflow `manuscript-review-fanout` — parallel reviewers (Sonnet agents + MCP-takeover for Codex/DeepSeek) |
| 5 | `05-aggregate.md` | Merge into `2-review/critiques.md` |
| 6 | `06-user-draft.md` | ⭐ Orchestrator generates complete draft, user edits (hard gate, session boundary) |
| 7 | `07-polish.md` | `manuscript-polisher-english` → `3-response/final.md` (plain text) |
| 8 | `08-archive.md` | Move to `archived/YYMMDD/<slug>/`, update global style + angles, optional postmortem |

## How to execute

At the start of each step, Read the corresponding sub-file and follow it. This file is the map — sub-files are the playbook.

## Resume table (which step to enter on re-invocation)

Re-invoking `/manuscript-review:new <slug>` resumes from the latest non-empty artifact:

| Existing artifact | Enter step |
|-------------------|-----------|
| `archived/*/<slug>/3-response/final.md` (glob) | 08 already done — confirm with user, use `/manuscript-review:rerun` instead |
| `ongoing/<slug>/3-response/final.md` | 08 |
| `ongoing/<slug>/3-response/draft.md` (non-empty) | 07 |
| `ongoing/<slug>/2-review/critiques.md` | 06 |
| `ongoing/<slug>/2-review/critiques/*.md` (all angles present) | 05 |
| `ongoing/<slug>/2-review/critiques/*.md` (partial — fewer files than angles in `angles.md`) | 04 (incomplete fanout — offer retry/skip/continue) |
| `ongoing/<slug>/2-review/angles.md` | 04 |
| `ongoing/<slug>/2-review/summary.md` (non-empty) | 03 |
| `ongoing/<slug>/2-review/literature.md` (non-empty) | 02b |
| `ongoing/<slug>/1-paper-text/paper.md` | 02 |
| `ongoing/<slug>/review-config.md` (no `paper.md` yet) | 01 |
| nothing | 00 |

`--restart-from <N>` jumps to any step. `--reingest` forces step 01 re-run. Partial fanout (fewer critiques than angles) → offer retry/skip/continue; never silently enter step 05 incomplete.

## Hard rules

- **Core** (see AGENTS.md): no opinion without reading `summary.md`; polisher never invents.
- **Literature before consensus**: step 02 → 02b; summary folds in landscape + venue type.
- **Venue type gates `Obvious gaps`**: EE conference → no hardware/code/data gaps; journal → fair game.
- **Intermediate-file language**: steps writing prose read `lang:` from `review-config.md` (default `en`). `final.md` is always plain-text English.
- **User gates**: steps 03 (angles) and 06 (draft) — iterate until approved; never skip.
- **Session boundary at 06**: pipeline yields control; resume by re-invoking with the slug.
- **Fanout is host-adaptive**: Claude's `manuscript-review-fanout` runtime handles `parallel()` and schemas; Codex uses collaboration/Fabric and then the same deterministic artifact validator. Routing remains `angles.md` override > agent frontmatter default.
- **Archive always updates** `style/profile.md` and `critiques-library/angles.md`, with dedup + rolling caps.

## Slug

Derive `<slug>` from the PDF filename (lowercase, non-alphanum → `-`, strip leading/trailing `-`). If the user passes an existing slug, use the resume table above.
