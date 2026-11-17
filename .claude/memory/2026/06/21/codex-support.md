---
name: codex-support
description: cc-market dual-host (Claude Code + Codex) support design and phased implementation -- single source generating derived artifacts, runtime normalization, capability degradation; includes phase 0 Codex CLI research findings
metadata:
  type: design
---

# cc-market dual-host support design (Claude Code + Codex)

> Status: phase 0 complete + phase 1 landed (manifest/marketplace generator + takeover E2E) · 2026-06-21
> Scope: make cc-market's plugins run on both hosts, Claude Code and Codex.
> This is a design document and contains no implementation. Implementation proceeds per the "phased" section.

## 1. Background and conclusion

Codex already ships a plugin / skill system that is **highly isomorphic** to Claude Code's. So "also support Codex"
is not a rewrite but **adaptation + derived generation**: treat the existing Claude-flavoured plugins as the single
authoritative source (single source of truth), generate Codex artifacts through a setup/migrate step, and add an
adaptation layer or a degradation for the few parts deeply bound to the Claude runtime.

Core judgement: **manifests and skills are essentially isomorphic; the gap concentrates in 4 places** -- manifest
directory name, plugin root variable, hook event contract, and the runtime assumptions of individual plugins.

## 2. Host capability comparison

| Dimension | Claude Code (current) | Codex | Difference level |
|---|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` (same schema + `interface` block) | Low (mechanical translation) |
| Marketplace manifest | `cc-market/.claude-plugin/marketplace.json` | `~/.agents/plugins/marketplace.json` or `<repo>/.agents/plugins/marketplace.json` | Low |
| Skills | `skills/<n>/SKILL.md` | `skills/<n>/SKILL.md` (frontmatter nearly identical; optional `metadata.short-description` + `agents/openai.yaml` interface file) | Low |
| MCP | `.mcp.json` | `.mcp.json` | None |
| Plugin root variable | `${CLAUDE_PLUGIN_ROOT}` (26 occurrences) | No variable of the same name; Codex uses `CODEX_HOME` as its home directory, plugin root injection variable to be verified | Medium |
| Hooks | `hooks/hooks.json` + Claude event names/payload | Supports a `hooks/` directory, but **event names and payload contract are not published in the system skills** | High (biggest unknown) |
| Workflow primitive | `Workflow` tool + subagent | No corresponding primitive | High (needs degradation) |
| Session/transcript storage | JSONL transcript | sqlite (`logs_2.sqlite`/`state_5.sqlite` etc.) | High (needs a separate ingester) |
| Install iteration | marketplace reference + symlink | marketplace reference + `update_plugin_cachebuster.py` cachebuster | Medium |

## 3. Overall strategy: single source + generated derivatives

Do not maintain two plugin trees. `scripts/setup/setup.js` (and `/migrate`) gains a **codex generation step** that produces the Codex artifacts from the authoritative Claude-flavoured plugins. Rationale: cc-market already
follows "edit in one place, distribute by symlink"; extending it to "edit in one place -> generate -> distribute to
two hosts" costs the least and avoids two copies drifting.

Landed in three layers:

### 3.1 Manifest layer (purely mechanical, low risk)
- Per plugin: generate `.codex-plugin/plugin.json` from `.claude-plugin/plugin.json`, adding the `interface`
  fields (`displayName`/`shortDescription`/`category`/`defaultPrompt` etc.).
- Generate `<repo>/.agents/plugins/marketplace.json`, translated from the existing `marketplace.json`,
  with `source.path` pointing at each plugin directory.
- On iteration, run Codex's `update_plugin_cachebuster.py` to trigger re-ingestion.
- Fully automatable; folded into setup.

### 3.2 Runtime normalization layer (medium risk, key)
- **Plugin root variable**: do not hard-replace the 26 `${CLAUDE_PLUGIN_ROOT}` occurrences. At the script entry read
  `process.env.CLAUDE_PLUGIN_ROOT || process.env.<CODEX_PLUGIN_ROOT>`, or use a normalized prefix in the hook
  command string. **Prerequisite: verify the name of the plugin root variable Codex injects** (`CODEX_HOME` is the
  home directory, not the plugin root).
- **Hook adaptation (largest uncertainty)**: `rem-hook.js` depends on Claude's `SessionStart`/`Stop` events,
  and on fields in the input such as `session_id`, `background_tasks`, `taskActiveUntil`. First verify Codex's
  event names and payload shape, then write a **thin adapter** translating the Codex payload into the shape the
  existing scripts expect -- **change the adaptation layer, not the scripts' core logic**.

### 3.3 Capability degradation layer (per plugin, see section 4)

## 4. Per-plugin portability assessment

| Plugin | Portability | Key obstacle | Suggested path |
|---|---|---|---|
| **takeover** | High | Pure MCP server, `.mcp.json` works on both sides | Almost no changes; **first validation target** |
| **watch** | High | Python, host-agnostic; only watchdog logic | Manifest translation is enough |
| **rem** | Medium | Hook payload adaptation + memory path | Hook adapter; `.claude/memory` is the single authoritative store, the codex hook points at it too (do not fork into `.codex/memory`) |
| **sharp-review** | Medium-low (**must do**) | Depends on the `Workflow` tool + parallel reviewers | Skill degrades to running reviewers sequentially; hook classification logic is reusable |
| **evolve** | Medium-low (**must do**) | Depends on Workflow / subagent fan-out | Same as above, degrade to sequential review->fix rounds |
| **traceme** | Partial | Reads the Claude transcript JSONL; Codex sessions are in sqlite | Manifest **already generated** (`gen-codex.mjs` produces it too, keeping the marketplace complete), but **runtime observation is not ported**: Codex sessions are stored in sqlite, a new ingester is needed, left for a separate later project |

Design principle: **capability degradation must be explicitly `log`ged**, never silently cut a feature (consistent with cc-market's existing "no silent caps" convention).

## 5. Phased implementation

**Phase 0 -- eliminate the unknowns (blocking)**
- Verify the name of the plugin root variable Codex injects.
- Verify Codex's set of hook event names and payload schema (whether SessionStart/Stop counterparts exist, field naming).
- Output: a one-page hook contract comparison table, added to section 2 of this document.

**Phase 1 -- pipeline through (✅ done)**
- ✅ `scripts/gen-codex.mjs`: from the authoritative Claude manifests, generates each plugin's `.codex-plugin/plugin.json`
  (strips `commands`/`hooks`, synthesizes `interface`, wires `mcpServers`/`skills`) +
  `.agents/plugins/marketplace.json`. Unit tests `tests/gen-codex.test.mjs` (9 cases).
- ✅ `scripts/codex-e2e.sh`: under an isolated `CODEX_HOME`, validates all 6 manifests -> `marketplace add` ->
  `plugin add takeover`, all passing; `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` is preserved verbatim.
- ✅ Incidentally fixed the missing `name` in `takeover/skills/codex-image-result/SKILL.md` (exposed by Codex's strict validation).
- TODO: a real `codex exec` run to verify MCP tool discoverability (needs codex login).

**Phase 2 -- hook adaptation**
- Write the hook adapter, verify **rem**'s SessionStart/Stop behaviour under Codex.
- ✅ **`.claude/rules` injection** (Codex does not natively load the `.claude/rules/` that Claude auto-injects):
  rem adds a SessionStart hook `scripts/inject-rules.js` -- a generic plugin-level mechanism (shipped once with rem's
  `hooks.json`, effective for **any** project Codex opens, reading that project's own
  `.claude/rules/**/*.md` and injecting it via `hookSpecificOutput.additionalContext`), **not inserted per project**.
  Host detection uses the already-substituted `${CLAUDE_PLUGIN_ROOT}` (Codex lives under `.codex/plugins/…`, Claude under
  `.claude/plugins/…`); under the Claude host it is a no-op (avoiding duplication with native auto-loading). Tests
  `rem/tests/inject-rules.test.mjs` (9 cases).

**Phase 3 -- host-adaptive parallel fan-out (✅ landed)** -- ⚠️ the original "sequential degradation" premise was overturned by §7.5.3:
Codex has native parallel `spawn_agent`, **no degradation**. Design points:
- **Not a degradation**: Claude goes through `Workflow`/`Agent`, Codex through `spawn_agent` (parallel) or takeover
  `call_model`. Both are parallel, no capability loss.
- **The only real difference = the Workflow VM**: Claude's `sharp-review-workflow.js` runs in a sandboxed VM
  (no import/FS, which is exactly why `buildDedupKey` is inlined rather than imported). Codex has no such VM; the main agent
  calls `spawn_agent` directly + runs ordinary node scripts.
- **Sharing refactor (enabler)**: extract the pure merge+render logic from the Workflow VM into `sharp-review/lib.mjs`
  (`mergeFindings`/`renderReviewMarkdown`/`buildDedupKey`, unit-testable). Both paths feed "each reviewer's
  raw findings" into the same merge logic (via `post-review.js`):
  - Claude: Workflow parallel reviewers -> return raw findings -> `post-review.js` merges + renders + writes to disk.
  - Codex: `spawn_agent` parallel reviewers -> raw findings -> the same `post-review.js`.
  - The only host difference is the fan-out tool name; merge/render/write are 100% shared, and finally unit-testable.
- evolve likewise: the fix-agent fan-out uses `spawn_agent` in Codex; the pure JS (groupFindings/
  checkTermination) is unchanged.

**Phase 3 landing list (2026-06-21):**
- ✅ `post-review.js --raw`: accepts each reviewer's raw findings + reviewer metadata, merges, renders and writes via the
  shared `mergeFindings`/`renderReviewMarkdown` -- a host-agnostic entry (Codex / any host without a Workflow
  VM takes this path); `--findings`/`--markdown` are kept for Claude Workflow and external content callers.
  Tests `tests/post-review-raw.test.mjs` (2 E2E cases) + the existing `merge-render.test.mjs` (8 cases).
- ✅ `sharp-review/SKILL.md`: Step 3 split into **3a (Claude Workflow) / 3b (Codex direct parallel
  `spawn_agent`/takeover `call_model` -> `post-review.js --raw`)**; Step 4 writes in both forms.
- ✅ `evolve/reference/round-protocol.md` + `AGENTS.md`: in evolve only **step 2 fan-out fix** is host-
  aware (`Agent`->`spawn_agent`, evolve's own subagent orchestration primitive, irreducible). **Step 1 critique
  is host-agnostic** -- evolve only "runs the sharp-review skill + reads backlog OPEN findings" (`seedFromSharpReview`);
  the Workflow-vs-raw-fan-out fork lives only in sharp-review and does not leak into evolve.
- ✅ Codex E2E prompts `scripts/codex-e2e-prompts.md` (the manual `codex exec` part that needs codex login:
  MCP tool discoverability, `.claude/rules` injection, sharp-review/evolve host branches, cross-host artifact alignment).
  -> Left for the user to run (not verified headless this round).

> **traceme is out of scope this round** (see section 4), not in the phase plan -- its Codex artifacts are removed, README marks it Claude-only.

## 6. Testing and constraints

### 6.1 Layered testing
- **Unit/integration**: follow cc-market's per-plugin convention (`node --test`). New codex manifest/hook
  generators need matching tests -- translation correctness, idempotence, TOML format, path absolutization.
- **E2E (key, covers host integration)**: driven by the **real CLI**, verifying the generated artifacts are truly ingested and triggered by both hosts,
  not just testing the generator's output strings:
  - **Codex**: `codex exec` (non-interactive) + `codex plugin add/list` to verify the plugin is discovered; under a temporary
    `CODEX_HOME` inject the generated marketplace + plugins, run a minimal prompt, assert the SessionStart/Stop
    hook really ran (the hook script drops a sentinel file / exit code), and handle the trust registration of 7.3.
  - **Claude Code**: `claude -p "<prompt>"` (headless / print mode) mounts the same plugin under a temporary `CLAUDE_HOME`
    or temporary project, asserting the corresponding hook fires -- guaranteeing the "single source" behaves the same on both hosts.
  - **takeover** goes through MCP: on both hosts start it once via `codex mcp` / Claude's MCP registration, asserting the tool is discoverable and callable.
  - The old isolated script `scripts/codex-e2e.sh` has been replaced by the real-install smoke test
    `scripts/codex-e2e-live.sh`: it needs a prior `codex login`, installs takeover/rem/sharp-review/evolve
    into the real `~/.codex` and keeps them, then probes hook firing, `.claude/rules` injection, skill ingestion and
    takeover MCP discoverability. The script explicitly prints the uninstall commands.
  - Every subprocess obeys `windowsHide: true` (see below); CLI calls get timeouts to avoid interactive hangs
    (`codex exec` / `claude -p` are both non-interactive).

### 6.2 Constraints
- Obey the dev/runtime boundary in `cc-market/.claude/rules/invariants.md`.
- Obey `no-terminal-flash` (every new spawn adds `windowsHide: true`).
- cc-market is a separate git repository: commit related changes with `git -C cc-market`.

## 7. Phase 0 research findings (Codex CLI 0.140.0)

> Data source: the embedded schema/strings of the local native Codex binary
> (`@openai/codex-darwin-arm64/.../bin/codex`) + the system skill
> `plugin-creator`. The following are facts a design can rest on; they overturn section 2's pessimistic "hook contract unknown" assumption.

### 7.1 Hook system: highly isomorphic to Claude ✅
- **Full event set (10)**: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
  `PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`.
  -> **Both `SessionStart` + `Stop`, which rem depends on, are present, essentially 1:1 with Claude.**
- **Hook input payload fields** (almost the same names as Claude, passed as stdin JSON):
  `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `source`,
  `turn_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message`, `prompt`.
- **Hook output**: `SessionStartHookSpecificOutputWire` / `PreToolUseDecisionWire` /
  `PreToolUsePermissionDecisionWire` etc. -- isomorphic to Claude's `hookSpecificOutput` / decision pattern.
- **⚠️ Note**: the Codex payload **shows no `background_tasks` field**. `rem-hook.js`'s
  "pending-work guard" depends on it -> the Codex path must fall back to the `taskActiveUntil` time window, or approximate with `turn_id`.

### 7.2 Major finding: Codex has a built-in Claude plugin compatibility layer ✅ (overturns the original "obstacles 1/2")
The earlier worries "no `${PLUGIN_ROOT}` variable" and "hooks must be hand-written TOML" **both do not hold**. Binary strings confirm
Codex deliberately does Claude-compatible ingestion:
- **Reads `hooks.json` directly** (Claude format), normalizing internally to TOML
  (`"normalized hook identity should serialize to TOML"`). No hand-written Codex TOML needed.
- **Recognizes and substitutes `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${PLUGIN_DATA}`** -- the existing 26 `${CLAUDE_PLUGIN_ROOT}` occurrences and the same-named variable in `.mcp.json`
  **most likely work verbatim, no path absolutization needed**.
- Hook event JSON names (snake_case, consistent with Claude): `pre_tool_use`, `permission_request`,
  `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `user_prompt_submit`,
  `subagent_start`, `subagent_stop`, `stop` (camelCase is the internal TOML form).

### 7.3 Hook trust + manifest field differences (the only real differences left)
- **Trust mechanism**: `HookStateToml.trusted_hash`, `HookMetadata.trustStatus`/`currentHash`
  -> plugin hooks still need a one-time **trust approval (hash comparison)** before running; E2E must handle it (interactive or scriptable, to be measured).
- **Manifest field trimming** (measured by the validator, see 7.4): `.codex-plugin/plugin.json` rejects the `commands` and
  `hooks` fields -- but `hooks.json` goes through **auto-discovery** (no declaration in the manifest needed), likewise `.mcp.json`.
  takeover's `commands` field must be removed from the Codex manifest (Codex exposes capabilities through skills).

### 7.4 Manifest/marketplace E2E measured passing ✅ (isolated `CODEX_HOME`, `codex` 0.140.0)
Ran the full chain with `scripts/codex-e2e.sh` under a temporary `CODEX_HOME` (zero pollution of the user's config):
1. `validate_plugin.py` passes -- confirming `.codex-plugin/plugin.json` **requires**: `name`, `version`
   (strict semver), `description`, `author.name`, `interface.{displayName, shortDescription,
   longDescription, developerName, category, capabilities[], defaultPrompt[]}`.
   **Allowed field set**: `id, name, version, description, skills, apps, mcpServers, interface,
   author, homepage, repository, license, keywords` -- `commands`/`hooks` **are not in it and are rejected**.
2. Marketplace layout: `marketplace add <root>` expects `<root>/.agents/plugins/marketplace.json`;
   plugin `source: {source:"local", path:"./plugins/<n>"}` resolves relative to `<root>`; every entry must contain
   `policy.{installation, authentication}` + `category`.
3. `codex plugin add <n>@<market>` installs the plugin to
   `$CODEX_HOME/plugins/cache/<market>/<n>/<version>/`, landing `.mcp.json` with it;
   `config.toml` gets `[marketplaces.<m>]` and `[plugins."<n>@<m>"] enabled=true`.
- Skills: `skills/<n>/SKILL.md` isomorphic; Codex additionally reads `agents/openai.yaml` (interface) and the optional
  `SKILL.json` (takes precedence over the frontmatter's `short_description`).

### 7.5 Measured results (2026-06-22, codex 0.141, real `~/.codex` install run via `scripts/codex-e2e-live.sh`)
**5/6 pass -- all core dual-host mechanisms verified; the only gap is MCP tools not discoverable under `codex exec`.**
1. ✅ **Confirmed by a real run**: hooks fire end to end under `codex exec` (probe log shows `hook: Stop` /
   `hook: Stop Completed`). `--dangerously-bypass-hook-trust` skips the one-time hash trust (an interactive session still prompts once).
2. ✅ **MCP tools discoverable under `codex exec` (fixed)** -- 2026-06-22 Windows/Codex 0.141
   initially reproduced `TOOL_NOT_FOUND`; the root cause was that Codex plugin MCP loading did not reliably use the `${CLAUDE_PLUGIN_ROOT}`
   in the Claude source `.mcp.json`. The fix is a repo-level dual-host contract, not a takeover/Windows special case:
   - Keep each plugin's Claude Code source `.mcp.json` verbatim, not disturbing Claude Code.
   - `gen-codex.mjs` generates `.codex-plugin/mcp.json` for plugins that have `.mcp.json`, normalizing only
     `${CLAUDE_PLUGIN_ROOT}` / `${PLUGIN_ROOT}`-prefixed paths into forward-slash plugin-relative paths
     (e.g. `./scripts/mcp-server.mjs`), and adds `cwd: "."`; ordinary commands and non-plugin paths are not rewritten.
   - `mcpServers` in `.codex-plugin/plugin.json` points at `./.codex-plugin/mcp.json`.
   Retest result: the `codex exec` log shows `mcp: takeover/list_models started` /
   `mcp: takeover/list_models (completed)`, finally returning the model-list JSON, no longer `TOOL_NOT_FOUND`.
   Earlier exclusions still hold:
   the takeover MCP server, driven locally over JSON-RPC, boots normally and lists 3 tools (`call_model`/`list_models`/
   `codex_status`).
2b. ✅ **`.claude/rules` injection passes in a real run** -- the probe project holds `.claude/rules/probe.md`; under `codex exec`
   the model answered with the injected phrase (`PROBE-RULE-OK-7Q`), proving rem's `inject-rules` SessionStart hook takes effect
   in Codex (Codex does not natively load `.claude/rules`). A 2026-06-22 retest under the current login still returned
   `PROBE-RULE-OK-7Q`; in the log, for the same SessionStart one hook failed and one completed, not affecting
   the `inject-rules` output. ✅ **Skill ingestion**: `sharp-review`/`evolve`/`rem`/`takeover`
   all visible.
3. ✅ **Confirmed -- Codex has native parallel subagents** (overturns the "degrade to sequential" premise). Binary evidence:
   - **`spawn_agent` tool**: `"Spawns an agent to work on the specified task. If your current
     task is /root/task1 and you spawn_agent with task_name "task_3" the agent will have
     canonical task name /root/task1/task_3"`, with `Available models:` (a model can be specified).
   - **Parallel**: `"there may be multiple workers making changes in parallel … be aware of each
     other's work"` + delegation guidance (`Designing delegated subtasks` / `After you delegate` /
     `Do not redo delegated subagent tasks yourself`); see also `SubAgentSource`,
     `subAgentThreadSpawn`, `process/spawn`.
   - **takeover MCP `call_model` is equally available under Codex** (takeover was Codex's first validation target anyway).
   -> **Conclusion: sharp-review / evolve need no "sequential degradation".** Phase 3 becomes "host-adaptive parallel fan-out":
     Claude uses `Workflow`/`Agent`, Codex uses `spawn_agent` (still parallel) or takeover `call_model`.
     The only real difference: Codex has no Workflow **VM** (sandbox without import/FS), so the pure merge/render logic must run as an ordinary
     Node step (the Codex main agent can just run the node script directly, no sandbox restriction) -- which is exactly the motive for extracting merge/render
     into `sharp-review/lib.mjs` (host-agnostic, unit-testable), shared by both hosts.
4. Whether the two hosts leave each other alone when `.claude-plugin/` and `.codex-plugin/` coexist in the same directory (verified by measurement).

### 7.6 Codex compatibility boundary (confirmed, handled by gen-codex)

**(a) Plugin slash-commands are not a Codex concept.** Codex's plugin components are only skills / hooks / mcpServers /
apps (the `commands` field is rejected by the validator, and the binary has no plugin-command auto-discovery). So `gen-codex.mjs`
drops the `commands` field. Impact:
- The **slash entries** of takeover (`/takeover:continue|models|summary`) and watch (`/watch:watch|check|setup`)
  **do not exist under Codex**; but their underlying capabilities stay reachable -- takeover through MCP tools
  (`call_model`/`list_models`/`codex_status`), skills through `skills/`.
- Codex also has user-level `~/.codex/prompts` custom prompts, a different mechanism from plugin commands, outside this round's mapping scope.

**(b) Hook event compatibility.** Codex supports 10 hook events (`PreToolUse`, `PermissionRequest`,
`PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`,
`SubagentStart`, `SubagentStop`, `Stop`). The Claude-only `Notification` and
`SessionEnd`, **unsupported by Codex**, silently never fire under Codex. Per-plugin measurement:

| Plugin | hooks.json events | Codex compatible |
|---|---|---|
| rem | SessionStart, Stop | ✅ fully compatible |
| sharp-review | Stop | ✅ |
| takeover / evolve | (no hooks.json) | ✅ |
| watch | **Notification**, Stop | ⚠️ Notification does not fire (alerts degrade to Stop-only) |
| traceme | SessionStart, Stop, **SessionEnd** | ⚠️ SessionEnd does not fire (out-of-scope anyway) |

-> **The hooks of the 4 must-do plugins this round (takeover/rem/sharp-review/evolve) are fully compatible.** `gen-codex.mjs`
now **prints a warning** at generation time for watch/traceme's unsupported events (`unsupportedHookEvents()`), moving
a silent runtime degradation forward into a generation-time visible warning. Codex hook adaptation for watch/traceme is left to their own later work.

**(c) `background_tasks` missing.** The Codex hook payload has no such field (see 7.1). rem's pending-work
guard falls back to the `taskActiveUntil` time window; multi-turn skills running under Codex (evolve/sharp-review) must set
`taskActiveUntil` at the start (evolve already does), otherwise the Stop hook may fire midway.

> Status: the manifest/marketplace contract is locked by generator tests and the live smoke test (7.4/7.5); `${CLAUDE_PLUGIN_ROOT}`
> compatibility is confirmed by the binary (7.2); the command/hook event compatibility boundary is clarified and auto-warned by gen-codex (7.6).
> 2026-06-22 related Node tests rerun passing: 57/57.
> Remaining gap: no current blocker. MCP exposure is fixed by the repo-level Codex-only MCP manifest generation; §7.5 item 4
> (coexistence without interference) is covered by the real-install smoke test's same-directory `.claude-plugin/` + `.codex-plugin/` install chain.

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
