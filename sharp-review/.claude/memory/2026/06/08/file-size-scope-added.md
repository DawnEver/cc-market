---
name: file-size-scope-added
description: Sharp review now flags files that grew past ~400 lines and suggests splitting them, per user request
metadata:
  type: project
---

# File-Size Review Scope Added

User asked sharp-review to watch for files exceeding ~400 lines and suggest decomposition.

**Why:** Large files accumulate unrelated concerns and become harder to review/maintain; a blunt nudge in the review prompt catches this early.

**How to apply:** Added one line to `REVIEW_SCOPE` in `sharp-review-workflow.js` — `'Files that grew past ~400 lines and should be split into smaller modules'`. Since all three reviewer prompts (`reviewPrompt`, `codexReviewPrompt`, `deepseekReviewPrompt`) interpolate the shared `REVIEW_SCOPE` constant, this single edit applies the check across Codex, DeepSeek, and Claude reviewers — no per-prompt duplication needed.
