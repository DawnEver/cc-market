---
name: codex-reviewer-restored
description: Reviewer A switched from plain Claude fallback to a real Codex adversarial reviewer via takeover's direct app-server integration
metadata:
  type: project
created: 2026-06-08
accessed: 2026-06-08
tier: short
---

# Codex Reviewer Restored in sharp-review-workflow.js

`takeover` (commit c5315cf) replaced `findCodexCompanion()` — which depended on the third-party `openai/codex-plugin-cc` plugin — with direct JSON-RPC to `codex app-server`. Installing a separate Codex plugin is no longer required.

**Why:** Reviewer A had been downgraded to a plain Claude agent (alongside B/C) because the Codex review path required that third-party plugin install. `[[takeover-model-bug]]` (DeepSeek/Claude takeover reviewers failing on `model="sonnet"`) was a separate, unrelated blocker that never affected codex.

**How to apply:** `sharp-review-workflow.js` Reviewer A now prompts an agent to call `mcp__plugin_takeover_takeover__call_model` with `provider="codex", mode="review"`, then translate Codex's adversarial findings into the FINDINGS_SCHEMA. Verified working end-to-end in two live workflow runs (2026-06-08) — all 3 reviewers returned OK including the Codex one. See cross-repo note `[[takeover-codex-direct]]` in the parent claude config repo.
