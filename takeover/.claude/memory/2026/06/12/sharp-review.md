---
name: sharp-review-2026-06-12
description: Sharp review findings — 15 total
metadata:
  type: project
---

## Review 2026-06-12 — Takeover Architecture (架构评审)

**Scope:** takeover plugin architecture — shortcomings and improvements only
**Reviewer:** Claude (direct architecture analysis, not workflow-driven)

### Architecture Summary

The takeover plugin is a multi-model AI orchestration layer built on MCP (Model Context Protocol). Its core flow: user command → Agent(takeover:takeover) gathers local context → MCP tool `call_model` → `mcp-server.mjs` routes to provider-specific backends (Claude native CLI, Codex app-server JSON-RPC, or Anthropic-compatible API).

---

### Findings

### [SR-20260612-001] [HIGH] [scripts/mcp-server.mjs] handleCallModel is monolithic — `handleCallModel` is ~150 lines mixing flag parsing, image resolution, provider routing, mode dispatch, error handling, and tracing into one function. Each provider path is untestable in isolation.

- **Module:** takeover/mcp
- **Category:** Bug
- **Suggestion:** Extract provider dispatch into a strategy map — `{ codex: { task, review, image }, api: { task, agent }, claude: { task, agent } }` — each strategy separately testable.
- **Status:** FIXED

### [SR-20260612-002] [HIGH] [scripts/codex/app-server.mjs] withSharedClient lock has no acquisition timeout — `withSharedClient` uses a promise-chain lock (`_lock`) to serialize codex app-server access. If one request hangs (e.g., app-server crash without close event), all subsequent codex calls silently queue forever. No timeout, no queue-depth visibility, no error surfaced to callers.

- **Module:** takeover/codex
- **Category:** Bug
- **Suggestion:** Add lock acquisition timeout (30s) with clear error; surface queue depth via stderr so operators can detect stuck clients.
- **Status:** FIXED

### [SR-20260612-003] [MEDIUM] [scripts/mcp-server.mjs] No structured error taxonomy — All errors thrown as generic `Error`. MCP error codes are coarse: `-32602` for string-match on "not found", `-32000` for everything else. The agent cannot distinguish retryable failures (429, network) from fatal ones (bad config, auth).

- **Module:** takeover/mcp
- **Category:** Bug
- **Suggestion:** Define `TakeoverError` subclasses (`ConfigError`, `ProviderError`, `TimeoutError`, `AuthError`) with `.code` and `.retryable` properties; map to MCP error codes precisely.
- **Status:** FIXED

### [SR-20260612-004] [MEDIUM] [scripts/lib.mjs] Provider config read on every call with no caching — `loadProviderConfig` reads and parses `claude_env_settings.json` from disk on every `call_model` invocation. If the file format changes, every code path breaks. No JSON schema validation.

- **Module:** takeover/lib
- **Category:** Performance
- **Suggestion:** Cache parsed config with TTL (60s); add JSON schema validation with clear error messages on malformed config.
- **Status:** FIXED

### [SR-20260612-005] [MEDIUM] [scripts/mcp-server.mjs] Image handling inconsistent across provider paths — API path uses proper structured content blocks (pixel-based billing), but Claude/Codex paths embed base64 data URIs into text prompts. The 150KB warning is a band-aid — it warns but doesn't prevent token overflow. Different providers get fundamentally different image quality/cost profiles.

- **Module:** takeover/mcp
- **Category:** Bug
- **Suggestion:** Reject images >150KB for text-embedding paths with clear error; auto-resize via sharp before embedding; or route image tasks exclusively to API providers that support content blocks.
- **Status:** FIXED

### [SR-20260612-006] [LOW] [scripts/lib.mjs] spawnClaudeP buffers entire output — no streaming — Unlike the codex path (notification-based streaming) and API path (SSE streaming), `spawnClaudeP` buffers all stdout and returns only on process close. For long-running tasks, the user sees nothing until completion or 600s timeout.

- **Module:** takeover/lib
- **Category:** Feature
- **Suggestion:** Stream stdout chunks via stderr progress messages (like codex path does); or parse stream-json output incrementally to emit partial results.
- **Status:** FIXED

### [SR-20260612-007] [MEDIUM] [scripts/lib.mjs] Command-block regex parsing is brittle with dual parsing — `parseCommandBlock` uses regex to extract flags from `<command>` blocks. The agent in `takeover.md` constructs the block, then `mcp-server.mjs` re-parses it. Two parsers that must agree on format. Regex fails silently on malformed blocks (returns empty flags), and there are no tests for edge cases like XML-like content in prompts or special characters.

- **Module:** takeover/lib
- **Category:** Bug
- **Suggestion:** Make `<command>` block the single source of truth; remove `[mode:task]` prefix from agent; add tests for edge cases (special chars, XML-like content in prompts, multi-line flags).
- **Status:** FIXED

### [SR-20260612-008] [MEDIUM] [agents/takeover.md] Agent context-gathering is unbounded — The agent reads file contents and diffs without any size limit before calling the remote model. In large repos, this can silently overflow the remote model's context window, causing truncated output or hallucinations on truncated input.

- **Module:** takeover/agent
- **Category:** Bug
- **Suggestion:** Add a ~50K char soft limit on gathered context; truncate with clear markers (`[...truncated N chars...]`); prioritize file contents over full diffs when near limit.
- **Status:** FIXED

### [SR-20260612-009] [LOW] [scripts/mcp-server.mjs] No request cancellation mechanism — Once `call_model` begins, there is no way to abort. The 600s timeout is the only escape hatch. For codex tasks, the app-server process keeps running even if the user has moved on.

- **Module:** takeover/mcp
- **Category:** Feature
- **Suggestion:** Add `AbortController` passthrough from MCP tool call to underlying fetch/spawn; expose via `notifications/cancelled` MCP method; kill codex app-server child process on cancel.
- **Status:** FIXED

### [SR-20260612-010] [LOW] [shared/state.mjs] Dead dependency — `shared/state.mjs` exports `loadState`/`saveState`/`appendEvent` but takeover never imports or uses them. The file is carried as shared infrastructure but serves no purpose in this plugin.

- **Module:** takeover/shared
- **Category:** Bug
- **Suggestion:** Remove `shared/state.mjs` from takeover; or use it for client singleton health state (last start time, error count, restart tracking).
- **Status:** FIXED

### [SR-20260612-011] [HIGH] [tests/] Test coverage dangerously thin — Only 2 test files have substantive logic tests (lib.test.mjs: 27 tests, mcp-server.test.mjs: 10 tests). No integration tests for `handleCallModel` routing. No tests for `withSharedClient` lock contention. Image tests only check "binary not found" error path. Discovery tests mock nothing — they depend on real codex installation. App-server tests only test constructor and `_handleLine` in isolation.

- **Module:** takeover/tests
- **Category:** Bug
- **Suggestion:** Add: (1) integration tests with mock fetch/spawn for each provider path (claude, codex, api, agent mode), (2) lock-contention test for `withSharedClient`, (3) end-to-end test for `parseCommandBlock` → `handleCallModel` → `extractText` pipeline.
- **Status:** FIXED

### [SR-20260612-012] [LOW] [AGENTS.md] Documentation drift — AGENTS.md file structure table references `scripts/jobs.mjs` which does not exist in the repository.

- **Module:** takeover/docs
- **Category:** Bug
- **Suggestion:** Remove `jobs.mjs` from AGENTS.md file structure; or implement the missing file.
- **Status:** FIXED

### [SR-20260612-013] [MEDIUM] [commands/continue.md] Dual mode specification — `commands/continue.md` tells the agent to prefix `[mode:task]`, while `parseCommandBlock` in `lib.mjs` looks for `--review`/`--image`/`--image-edit` flags inside `<command>` blocks. Two different formats, two different parsers, two sources of truth for the same concept.

- **Module:** takeover/commands
- **Category:** Bug
- **Suggestion:** Consolidate to `<command>` block only; remove `[mode:task]` prefix from agent instructions; add explicit `mode=` key in `<command>` block as a structured alternative to `--flags`.
- **Status:** FIXED

### [SR-20260612-014] [LOW] [scripts/lib.mjs] No structured observability — Only ad-hoc `process.stderr.write` lines and NDJSON usage traces. Debugging routing failures, timeout cascades, or partial outputs requires reconstructing events from interleaved stderr timestamps across multiple processes.

- **Module:** takeover/lib
- **Category:** Feature
- **Suggestion:** Add structured JSON log lines (ndjson to stderr) with `request_id`, `provider`, `mode`, `duration_ms`, `status` for every `call_model` invocation; build a small log analyzer script for debugging.
- **Status:** FIXED

### [SR-20260612-015] [LOW] [scripts/lib.mjs] CONFIG_PATH resolved at import time — `CONFIG_PATH` is set at module load via `process.env.TAKEOVER_CONFIG_PATH || default`. If the env var is set after import (e.g., by a test setup that loads modules first), it is silently ignored.

- **Module:** takeover/lib
- **Category:** Bug
- **Suggestion:** Use a getter function `getConfigPath()` that evaluates `process.env.TAKEOVER_CONFIG_PATH` at call time rather than at import time.
- **Status:** FIXED

---

### Architectural Improvement Directions

Beyond individual findings, three structural improvements would materially strengthen the architecture:

1. **Provider Strategy Pattern.** Currently `handleCallModel` is a single function with nested if/else chains. A provider strategy registry — `Map<provider, { task(), review(), image(), agent() }>` — would make each path independently testable, enable runtime provider registration, and eliminate the current 150-line monolith.

2. **Middleware Pipeline.** Pre/post processing concerns (flag parsing, image resolution, tracing, error normalization) are currently interleaved with business logic. A lightweight middleware chain — `parseFlags → resolveImages → dispatch → trace → normalizeError` — would separate concerns and make each step testable in isolation.

3. **Health-Aware Client Singleton.** The `CodexAppServerClient` singleton (`getSharedClient`/`withSharedClient`) should track health state (consecutive failures, last successful request time) and auto-reset on degradation. Combined with the lock-timeout fix (SR-20260612-002), this would make the codex path resilient to app-server crashes.
