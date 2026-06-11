---
name: takeover-codex-direct
description: takeover replaced findCodexCompanion (third-party plugin dep) with direct Codex app-server JSON-RPC — sharp-review's Codex reviewer restored
metadata:
  type: project
---

# Takeover: Direct Codex App-Server Integration

`cc-market/takeover` commit c5315cf replaced `findCodexCompanion()` (depended on the third-party `openai/codex-plugin-cc` plugin) with direct JSON-RPC 2.0 communication to `codex app-server` (`takeover/scripts/codex/{app-server,discovery,task,review,image}.mjs`). Installing a separate Codex plugin is no longer required — `mcp__plugin_takeover_takeover__call_model` with `provider=codex, mode=review` runs Codex's adversarial review natively.

**Why:** `[[takeover-model-bug]]` only affected non-codex providers (model selection in `resolveModel`/API path); the codex review path (`runCodexReview`) was always blocked by the plugin-install requirement, not the model bug.

**How to apply:** sharp-review's workflow (`cc-market/sharp-review/scripts/sharp-review-workflow.js`) now runs Reviewer A as a real Codex adversarial reviewer via the takeover MCP tool (replacing the 3x-plain-Claude fallback put in place while the plugin dependency blocked it), with Reviewers B/C remaining independent Claude agents. See [[sharp-review-workflow-bugs]] for the prior 3-Claude fallback rationale.
