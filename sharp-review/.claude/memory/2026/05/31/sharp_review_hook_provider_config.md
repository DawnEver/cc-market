---
name: sharp-review-hook-provider-config
description: sharp-review-hook.js now reuses Claude Code provider env vars instead of hardcoding api.anthropic.com
metadata:
  type: project
created: 2026-05-31
accessed: 2026-05-31
tier: short
---

## What changed
`scripts/hooks/sharp-review-hook.js` `classify()` was hardcoded to `https://api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY` — ignored the active provider config entirely.

### Fix
Added `resolveProviderConfig()` that reads the same env vars `cc.js` sets:
1. **Foundry mode** (`CLAUDE_CODE_USE_FOUNDRY=1`): uses `ANTHROPIC_FOUNDRY_BASE_URL` + `ANTHROPIC_FOUNDRY_API_KEY`
2. **Custom base URL** (`ANTHROPIC_BASE_URL`): uses `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
3. **Default Anthropic**: uses `ANTHROPIC_API_KEY`

All branches require `ANTHROPIC_DEFAULT_HAIKU_MODEL` env var — no hardcoded model fallback. If model or API key is missing, falls back to `mode: 'once'`.

**Why:** DeepSeek users via Foundry mode had `ANTHROPIC_FOUNDRY_API_KEY` in environment but the hook was looking for `ANTHROPIC_API_KEY` → classification always failed silently → defaulted to one review round.

## Future improvement options
Discussed three more elegant approaches for the classifier:
- **Heuristic**: classify by file count/type, zero API call
- **`claude -p` subprocess**: fully reuse Claude Code config, zero protocol code
- **Fixed `once`**: drop classifier entirely, let `/sharp-review` handle deeper reviews

None implemented yet.
