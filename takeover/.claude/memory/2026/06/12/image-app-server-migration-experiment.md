---
name: image-app-server-migration-experiment
description: Experiment confirmed app-server turn/start can handle image generation/edit — migration implemented
metadata:
  type: project
---

# Image Migration to App-Server — Experiment Results

Experiment ran 2026-06-11 on codex v0.139.0. Two test scripts (discarded — they were
discovery tools, not automated tests) validated each concern in the migration analysis.

## Core conclusions

1. **app-server turn/start generates AND edits images** — via the `imagegen` skill (not
   `image_gen` tool). The skill invokes subprocesses internally (Python/PIL) through
   `codex_core::tools::router`, but these don't fire `tool/start` MCP notifications —
   they're skill-internal. Zero `image_gen` tool calls observed; the skill achieves the
   same result.

2. **`tools: { disabled: true }` is the blocker** — with tools disabled, the model falls
   back to hand-writing SVG text. The `imagegen` skill cannot activate. Removal is
   required for both generate and edit modes.

3. **`localImage` type solves data URI inflation** — `turn/start` input supports
   `type: "localImage"` with a `path` field. This is the direct equivalent of
   `codex exec --image <path>` — Codex reads the file from disk, zero token overhead.
   `type: "image"` with data URIs also works but inflates 33%+ into prompt tokens.

4. **No approval prompts** — app-server `turn/start` is autonomous by default. The
   `--full-auto` flag from `codex exec` has no equivalent because none is needed.

## What was migrated (2026-06-12)

- `image.mjs`: `generateImage()` and `editImage()` rewritten to use `CodexAppServerClient`
  instead of `spawn("codex exec --full-auto")`. Accept optional `client` for shared
  singleton use. `localImage` type for edit input. Output parsed from `item/completed`
  notifications (markdown links / inline paths) instead of stdout `SAVED:` lines.

- `mcp-server.mjs`: image-generate and image-edit modes now wrapped in `withSharedClient`,
  sharing the app-server process with task/review modes.

- `app-server.mjs`: `stop()` no longer returns early when `_closed` is true — it
  always destroys child stdio to prevent event loop hangs on early failure.

**Why:** Unifies all codex communication on JSON-RPC (one code path instead of two),
shares the app-server process (no cold start per image call), structured output from
item/completed notifications, and unified timeout via CodexAppServerClient.

**How to apply:** No config changes needed. Image modes automatically use the shared
app-server client. `tools: { disabled: true }` is NOT sent for image modes.
