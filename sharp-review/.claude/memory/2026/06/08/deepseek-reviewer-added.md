---
name: deepseek-reviewer-added
description: Reviewer B switched from a duplicate plain Claude agent to an independent DeepSeek perspective via takeover, for genuine model diversity across the 3 reviewers
metadata:
  type: project
---

# DeepSeek Reviewer Added as Reviewer B in sharp-review-workflow.js

Previously Reviewers B and C were both plain native Claude agents — redundant perspectives running the identical model. User asked why not diversify (e.g. one via takeover→DeepSeek, one via official Claude subscription).

**Why:** `[[takeover-model-bug]]` (DeepSeek/Claude takeover reviewers failing on `model="sonnet"`) is now fixed — `parseCommandBlock()` makes the `<command>` block's `--provider`/`--model` flags authoritative in `handleCallModel` (verified via 46/46 passing tests in `takeover/tests/{lib,mcp-server}.test.mjs`). This unblocked using takeover for a genuinely independent model.

User suggested `--provider deepseek --model opus`, but that would fail: `loadProviderConfig` only reads `ANTHROPIC_DEFAULT_SONNET_MODEL` (not OPUS) for `defaultSonnet`, and `callAnthropicAPI` sends the model string to DeepSeek's endpoint literally with no translation — DeepSeek only accepts `deepseek-v4-pro[1m]` / `deepseek-v4-flash` style names, so `"opus"` would reproduce the original bug under a different guise.

**How to apply:** `sharp-review-workflow.js` Reviewer B now prompts an agent to call `mcp__plugin_takeover_takeover__call_model` with `provider="deepseek"` and **no explicit `model`** — it falls back to the configured `ANTHROPIC_DEFAULT_SONNET_MODEL` (`deepseek-v4-pro[1m]` per `claude_env_settings.json`). The instruction is embedded in a `<command>` block so `parseCommandBlock()` parses it authoritatively. Reviewer A = Codex (see `[[codex-reviewer-restored]]`), Reviewer B = DeepSeek, Reviewer C = native Claude — three genuinely distinct model perspectives.
