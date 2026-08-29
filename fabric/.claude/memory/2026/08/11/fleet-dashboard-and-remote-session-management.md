---
name: fleet-dashboard-and-remote-session-management
---

# Fleet dashboard + remote session management (device status, view/converse/kill)

User directives (2026-08-11): (1) show each online device with CPU busy %, mem free/total,
uptime in d/h/m; (2) from device A manage device B's sessions — view content, converse,
kill; (3) default session config `deepseek-v4-flash max`; (4) live-test whether WS1/WS2
can spawn new sessions.

## What shipped

**Rich device status.** `node/status` now reports `hostname` + `cpu_busy_pct` (a short
cross-platform sample of `os.cpus()` cumulative times — `os.loadavg` is `[0,0,0]` on
Windows). New `engine/sysinfo.mjs` (`sampleCpuBusyPct`, `localStatus`), `engine/node-probe.mjs`
(`pingNodes`, moved from web/api.mjs and shared by list_nodes + web console),
`scripts/lib/format.mjs` (`fmtUptime` d/h/m, `fmtMem`, `fmtAgo`). `ping.mjs` and the web
console machines card render uptime d/h/m + CPU busy % + mem free/total. MCP `list_nodes`
is now a **live fleet dashboard**: this machine + every peer probed concurrently, with
ALIVE/DEAD, version, uptime, CPU%, mem, and each node's sessions (the manageable
"processes").

**Remote session management.** New read-only `node/view {id, tailChars?}` (unrestricted by
owner, like status/ping — viewing is visibility, acting is gated). claude/API children now
ALWAYS record a transcript (tee was gated on visible/interactive; the viewer *window* stays
opt-in) and expose `view()` → transcript tail + liveness facts. Remote handles forward
`node/view`. New MCP tools: `session_view` (`id` local/owned — forwards; or `node`+`remoteId`
direct probe) and `attach_session` (adopt a shared remote session to drive it).
`session_send`/`session_close` already drove owned/shared remote sessions.

**Default session config.** `fabric.sessionDefaults = {provider, model, effort}` — a BUNDLE:
an explicit provider opts out of the default's model/effort (a deepseek model id must never
ride a claude session). Resolved in `resolveSessionDefaults` (openProviderSession, MCP
`call`), and peer-side in `node/spawn` (serve.mjs passes it). Live config set to
`{deepseek, deepseek-v4-flash[1m], max}`; web console spawn form preselects it.

## Live finding: WS1 could NOT spawn — hardcoded OneDrive path in shared config

WS2 spawned+sent+closed cleanly (`WS2-OK`). WS1's child exited 1 at startup:
`System prompt file not found: C:\Users\linxu\OneDrive - The University of Nottingham\Sync\claude\system-prompt\claude-base.md`.
The synced `fabric.systemPromptFile` had baked in G's absolute OneDrive path. WS1's user is
**ezxmb14** (not linxu) — the file DID exist on WS1 at `C:\Users\ezxmb14\...\claude-base.md`,
but the config pointed at the linxu path. The CLI exits 1 on a nonexistent
`--system-prompt-file`, bricking EVERY session on a peer with a different username.
`codex_config.toml` had the SAME hardcoded linxu path for `model_instructions_file`.

## First-principles redesign (2026-08-11): symlink-based platform prompts

**Convention: shared configs never carry a machine-specific (OneDrive) path.** setup.js now
links `~/.claude/system-prompt` and `~/.codex/system-prompt` → `<repo>/system-prompt` (dir
junctions), so prompt files are referenced by their symlink path:
- `fabric.systemPromptFile = "~/.claude/system-prompt/claude-base.md"` — resolved by
  `resolveSystemPromptFile` in node-config.mjs (expands `~` → home; the junction does the
  rest). Resolved value contains NO OneDrive.
- `codex_config.toml model_instructions_file = "~/.codex/system-prompt/codex-base.md"` —
  codex expands `~`/`./` against `~/.codex/` (verified: `~/` officially supported).
- `resolveSystemPromptFile` keeps an absolute-path passthrough (explicit override) and a
  relative→repo-root fallback (works before setup runs).
- Both CLI injection sites (`open-session.mjs`, `spawn-child.mjs`) also SKIP a missing file
  with a stderr warning (the API path already did), so a machine without the file/symlink
  still spawns (stock prompt) instead of exiting 1.

**Version honesty:** `pluginVersion()` is now MEMOIZED at first read — node/status reports
the version of the CODE actually running, not a plugin.json auto-updated on disk after
start (WS2's banner said v0.1.14 while status reported v0.1.19, observed live).

**Operational:** WS1/WS2 each need `npm run setup` (creates the system-prompt junctions)
+ a serve restart with the new code. `node/view` is UNSUPPORTED on both peers until their
serves run the new version — the feature set lands via the normal plugin update cycle.

## Design notes

- `cpuSampleMs: 0` opts out of the CPU sample (tests stay fast; `cpu_busy_pct: null`).
- A pre-existing raw-socket test assumed concurrent JSON-RPC replies arrive in order; the
  120ms CPU sample exposed the race — fixed the test to match by id (dispatch is
  non-awaiting by design).
- The default session is a bundle, not three independent defaults — documented in
  `resolveSessionDefaults` and `node/spawn`.
