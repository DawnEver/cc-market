---
name: takeover-image-limits
description: Claude -p no multimodal, codex app-server protocol unstable — dead ends
metadata:
  type: project
---

# Takeover Image Handoff — Known Limitations

## claude -p: no multimodal support
- stream-json content blocks → `[Unsupported Image]`
- data URI in text → model sees base64 as plain text, doesn't decode
- `--file <path>` → requires session token, not for local files
- **Only viable**: `callAnthropicAPI` with real Anthropic API key (separate from Pro/OAuth)

## Codex app-server: protocol fixed (codex v0.139.0)

`turn/start` now requires:
```json
{
  "threadId": "...",
  "input": [
    {"type": "text", "text": "system prompt (optional)"},
    {"type": "text", "text": "user message"}
  ]
}
```
Valid `type` values on input items: `text`, `image`, `localImage`, `skill`, `mention`. No `messages` or `role` field needed (role auto-detected from position).

`review/start` now requires `instructions` inside `target`:
```json
{
  "threadId": "...",
  "target": {
    "type": "custom",
    "diff": "...",
    "instructions": "Review instructions / system prompt"
  }
}
```

Both protocols verified working on codex v0.139.0.

## Working image path
- `callAnthropicAPI` with `type: "image"` content blocks — API charges by pixel dimensions (~2800 tokens for 1920x1080)
- Requires Anthropic API key (console.anthropic.com, separate billing from Pro)

## stdin pipe fix (for text)
- `claude.exe -p --input-format stream-json --output-format stream-json` works reliably
- JSON over stdin, no cmdline length limits
- Direct binary spawn (no shell) avoids cmd.exe stdin breakage

**Why:** claude -p is non-interactive print mode; it doesn't support multimodal input at all.

**How to apply:** Text handoffs → `--provider claude`. Image handoffs → need API key provider via `callAnthropicAPI`.
