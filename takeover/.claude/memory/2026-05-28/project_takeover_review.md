---
name: takeover-review-fixes
description: Key architectural invariants and test patterns for the takeover plugin after 3-round sharp review and full fix pass
metadata:
  type: project
created: 2026-05-28
accessed: 2026-05-28
tier: short
---

Takeover plugin (cc-market/takeover/) completed 3-round sharp review and full fix pass on 2026-05-28.

**Why:** 9 issues identified across code safety, test honesty, and operational resilience. All fixed and verified with 38 passing tests.

**Architectural invariants established:**
- Prompt must never appear in spawn args; always delivered via stdin (heredoc for API providers, pipe for Codex).
- `callCodexCompanion`, `callAnthropicAPI`, `callNativeClaude` live in lib.mjs as exported functions — testable directly.
- Both `/takeover:continue` and `/takeover:plan` route through Agent(`takeover:takeover`) for unified error handling.
- `--write` rejected early in main() for non-codex providers, not deep in call chain.
- Retry: 429/502/503/504 get 2 exponential-backoff retries (1s, 2s); 4xx client errors fail immediately.
- Config path overridable via `TAKEOVER_CONFIG_PATH` env var (same pattern as `TAKEOVER_CODEX_COMPANION`).

**How to apply:** When modifying takeover, run `node --test cc-market/takeover/tests/companion.test.mjs`. The 38 tests cover: provider config, arg parsing, prompt building, text extraction, Codex stdin delivery, Anthropic API URL/headers/body/retry/error behavior.
