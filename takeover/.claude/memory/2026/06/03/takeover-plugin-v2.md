---
name: takeover-plugin-v2
description: Takeover plugin cleanup — MCP self-declaration, version from plugin.json, bump-version fix, Windows spawn fix, dead skills removed
metadata:
  type: project
---

Takeover plugin (cc-market/takeover/) cleanup session.

**Changes:**
- `mcp-server.mjs`: reads `SERVER_NAME`/`SERVER_VERSION` from `.claude-plugin/plugin.json` at runtime (was hardcoded)
- `.mcp.json`: created — declares MCP server with `${CLAUDE_PLUGIN_ROOT}` for cross-platform auto-start/stop (no settings.json config needed)
- `bump-version.sh`: fixed to bump `.claude-plugin/plugin.json` instead of nonexistent `package.json`
- `lib.mjs`: `callNativeClaude` now uses `shell: process.platform === "win32"` — fixes `spawn("claude")` resolving POSIX script instead of `claude.cmd` on Windows
- `skills/takeover-runtime/`: deleted — dead skill, redundant with README and MCP tool schemas
- `cc-market/.git/hooks/pre-push`: created — auto-bumps plugin versions on push
- `README.md`: removed takeover-runtime reference

**Why:** 3-round sharp review (Codex failed sandbox, Claude failed Windows spawn, DeepSeek succeeded). Hardcoded version would drift from plugin.json. MCP config was Windows-only hardcoded path.
