---
name: sharp-review-2026-07-08
description: Sharp review findings — 42 total
metadata:
  type: project
---






## Review 2026-07-08 (session) — docs review (文档锐评) + diff review

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260708-001] [HIGH] README.md — Fabric plugin entirely absent from the 'Available plugins' table

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a row for fabric to the table: `| [fabric](fabric/README.md) | Multi-provider agent session fabric: spawn & observe isolated child sessions of any provider |`

The 'Available plugins' table at line 53-59 lists 6 plugins but omits fabric, which has been added as the 7th plugin (version 0.1.0). Users browsing the README will not know fabric exists.

---

### [SR-20260708-002] [HIGH] README.md — Fabric plugin absent from the 'Host support' table

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a row: `| [fabric](fabric/README.md) | yes | yes | MCP server + shared library consumed by both hosts. |`

The host-compatibility table at line 19-26 lists 6 plugins and their Claude Code / Codex support status, but fabric is missing. Users cannot tell at a glance whether fabric works on their host.

---

### [SR-20260708-003] [HIGH] README.md — Fabric plugin missing from the 'Install' section

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `/plugin install fabric@cc-market` to the install command block at line 63-69

The install section lists only 5 plugins. fabric is installable (has .claude-plugin/plugin.json and is listed in marketplace.json) but users won't find the install command here.

---

### [SR-20260708-004] [HIGH] README.md — Test command omits fabric test files

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Append `cc-market/fabric/tests/*.test.mjs` to the test command at line 78

The manual test command lists suites for all old plugins and gen-codex, but omits cc-market/fabric/tests/*.test.mjs (mcp-server and observe-proxy tests). The pre-commit hook at scripts/git-hooks/pre-commit already includes fabric in its node_tests array — so the README is out of sync with the actual test runner.

---

### [SR-20260708-005] [HIGH] fabric/ — Fabric is missing CLAUDE.md and AGENTS.md required by project conventions

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Create fabric/CLAUDE.md containing @AGENTS.md and fabric/AGENTS.md with plugin architecture, file map, invariants, and testing instructions, matching the pattern of every other plugin.

All 6 established plugins (takeover, rem, sharp-review, evolve, watch, traceme) have both CLAUDE.md and AGENTS.md for progressive disclosure. fabric has neither, which means devs working on fabric lack project-level context.

---

### [SR-20260708-006] [HIGH] fabric/.claude/rules/ — Fabric is missing .claude/rules/invariants.md

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Create fabric/.claude/rules/invariants.md with dev-only constraints: observe-proxy invariants, provider config, MCP protocol expectations, and testing conventions.

fabric/.claude/rules/ contains only MEMORY.md. The cc-market invariants.md template is clear that dev-only constraints belong here: 'invariants.md is for dev principles, not skill content.' Every other plugin has this file.

---

### [SR-20260708-007] [HIGH] fabric/.codex-plugin/ — Fabric has no generated Codex artifacts despite being Codex-compatible

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Run `node scripts/gen-codex.mjs .` from the repo root to generate fabric/.codex-plugin/plugin.json and fabric/.codex-plugin/mcp.json.

fabric's marketplace entry does NOT have "codex": false, has .claude-plugin/plugin.json, and has fabric/.mcp.json. gen-codex.mjs would generate both Codex artifacts for fabric, but neither exists — Codex users cannot install fabric even though nothing in the metadata says they shouldn't.

---

### [SR-20260708-008] [MEDIUM] takeover/AGENTS.md — Takeover AGENTS.md shared/ file listing is substantially incomplete

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update the shared/ tree to list all 11 files actually present: add observe-proxy.mjs, observe-reader.mjs, open-session.mjs, attention.mjs, spawn.mjs, stamp.mjs, state.mjs, lib.mjs alongside the existing entries.

The AGENTS.md shows only 4 entries under takeover/shared/ (spawn-child.mjs, anthropic-http.mjs, providers.mjs, codex/). The actual directory has 11+ files bundled from cc-market/shared/ — the doc gives a misleading picture of what the plugin ships.

---

### [SR-20260708-009] [MEDIUM] README.md — Codex e2e section says 'four in-scope plugins' with no mention of fabric's Codex status

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either include fabric in the e2e test or document why it's excluded, and update the count/language accordingly.

Line 81-83: 'it installs the four in-scope plugins (takeover, rem, sharp-review, evolve)'. With fabric now existing and having no codex: false marker, this should either include fabric or explicitly explain its exclusion.

---

### [SR-20260708-010] [MEDIUM] README.md — Pre-commit hook path is factually wrong and contradicts AGENTS.md

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace '.git/hooks/pre-commit' with 'scripts/git-hooks/pre-commit (wired via core.hooksPath)' at line 75.

Line 75 says the pre-commit hook is .git/hooks/pre-commit. The repo has core.hooksPath set to scripts/git-hooks, so .git/hooks/pre-commit does not exist and is never executed. AGENTS.md (line 27) is correct; the README is stale.

---

### [SR-20260708-011] [MEDIUM] README.md — Codex add-marketplace section omits fabric from the install command comment

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Line 46: change '# then rem / sharp-review / evolve / watch' to include fabric (or document if fabric is not Codex-ready).

The Codex instructions at line 46 list which plugins to add but fabric is not mentioned. Combined with the missing .codex-plugin/ dir, a Codex user would not know fabric exists or how to install it.

---

### [SR-20260708-012] [LOW] traceme/AGENTS.md — Test count and suite count are stale

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update to '67 tests across 7 suites' or remove the count entirely (it will keep drifting).

traceme/AGENTS.md claims '58 tests across 6 suites' but the actual count is 67 across 7 test files. The per-category breakdown also doesn't sum to 58.

---

### [SR-20260708-013] [LOW] fabric/README.md — Fabric README has no install section or usage examples with shell commands

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add install instructions (how to register the MCP server in settings.json) and concrete usage examples showing MCP tool invocation or library imports.

All other plugin READMEs have a dedicated 'Install' section plus 'Usage' examples. fabric's README is a design overview with architecture and roadmap but no actionable install/usage instructions.

---

### [SR-20260708-014] [MEDIUM] shared/anthropic-http.mjs — SSE 'fall back to non-streaming' retry never actually disables streaming

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Track stream state in a mutable local (`let useStream = stream`) and set it false in the fallback branch, instead of `delete body.stream; continue` which the loop-top `if (stream) body.stream = true;` immediately undoes.

In callAnthropicAPI, when parseSSEStream throws, the code does `delete body.stream; continue;` intending a non-streaming retry. But the first statement of every loop iteration is `if (stream) body.stream = true;` — stream is the immutable parameter, so the retry re-enables streaming and hits the exact same failure path until retries are exhausted. The fallback is dead. This bug was copied verbatim from takeover/scripts/lib/callers.mjs during promotion and is now replicated into 8 bundled copies.

---

### [SR-20260708-015] [MEDIUM] shared/spawn-child.mjs — onText streaming parser drops JSON lines split across stdout chunk boundaries

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Buffer partial lines the way CodexAppServerClient does (lineBuffer += chunk; lines = buffer.split('\n'); buffer = lines.pop()), then parse only complete lines. Consider extracting one line-buffered NDJSON reader shared with app-server.mjs.

The child.stdout.on('data') handler splits each chunk on '\n' and JSON.parses each fragment, swallowing failures with an empty catch. stream-json lines from claude regularly exceed one pipe chunk, so both halves of a split line fail to parse and that text silently never reaches onText. The final result is safe (parseStreamJsonOutput re-parses the full stdout), but the live progress stream — used by takeover to stream to stderr — loses or garbles text nondeterministically. The old takeover code had the same flaw; it was rewritten here without fixing it.

---

### [SR-20260708-016] [LOW] takeover/scripts/lib/spawn.mjs — Silent behavior change: takeover's claude mode now strips all provider env keys from the inherited env

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** If intentional (probably — clean OAuth env), state it in takeover/AGENTS.md or the spawn.mjs header; a user whose parent session routes claude via ANTHROPIC_BASE_URL will get silently different routing in the child.

Old spawnClaudeP passed env = process.env untouched for provider 'claude'. New spawnChild goes through buildChildEnv -> loadProviderEnv('claude'), which deletes every PROVIDER_ENV_KEYS entry (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL, Foundry vars...) from the inherited env. If the hosting session itself runs claude through an env-configured gateway, the takeover child now bypasses it and direct-connects with OAuth. Defensible design, but an unstated behavior change buried in a 'pure refactor' commit.

---

### [SR-20260708-017] [LOW] shared/spawn-child.mjs — Image content-block building and stream-json text extraction each exist twice

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract a buildUserContent(prompt, images) helper shared by spawn-child.mjs and anthropic-http.mjs, and have the onText chunk handler reuse the extraction logic of parseStreamJsonOutput (per-line) instead of re-implementing it inline.

The ~12-line image content-block builder is duplicated verbatim between spawn-child.mjs (stdin payload) and anthropic-http.mjs (messages body). Within spawn-child.mjs itself, the assistant/result text extraction appears twice: once in the onText data handler and once in parseStreamJsonOutput. In a change whose entire purpose was killing duplication, three new intra-shared duplications were introduced.

---

### [SR-20260708-018] [LOW] shared/codex/app-server.mjs — withSharedClient lock-timeout rejection leaves _lock as a rejected promise and can surface as an unhandled rejection

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Reject only the current caller (race the queue-wait against the timeout) instead of rejecting the shared _lock; or reset _lock = Promise.resolve() after rejecting it and attach a no-op catch.

When the 30s lock timeout fires, rejectLock rejects the promise that is now _lock. The next caller chains prev.then(...): prev is rejected, so it skips the work and hits .catch, releasing its own lock and rethrowing the stale 'Lock acquisition timed out' error — one innocent subsequent caller fails with the previous caller's error. If no caller ever chains, the rejected _lock is an unhandled rejection. Pre-existing in the takeover fork, but promotion to shared/ now replicates it into 6 plugins.

---

### [SR-20260708-019] [LOW] shared/codex/app-server.mjs — resolveClientInfo aborts the upward walk on a malformed plugin.json instead of continuing

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** In the catch, dir = dirname(dir); continue; (or just fall through to the parent step) rather than break.

If the nearest .claude-plugin/plugin.json fails JSON.parse, catch { break; } gives up entirely and returns the cc-market/0.0.0 fallback even when a valid manifest exists further up the tree. Marginal in practice, but the walk-up exists precisely to be robust, and the fix is one line.

---

### [SR-20260708-020] [INFO] takeover/scripts/lib/spawn.mjs — Short-prompt timeout doubled (300s -> 600s) and timeout now rejects instead of resolving with the killed child's output

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** None needed — noting the behavior changes for the record since the commit is labeled a pure refactor.

spawnClaudeP now passes timeoutMs: 600000 for all prompts (old non-stdin path armed a 300s kill timer), and spawnChild's watchdog rejects with a 'timeout after Nms' error, whereas the old stdin path killed the child and let the close handler resolve with whatever partial output existed. Both arguably improvements; neither documented.

---

### [SR-20260708-021] [INFO] scripts/git-hooks/pre-push — find|tar|tar pipeline for recursive bundling is clever but tar-dialect-dependent

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Fine as-is for Git Bash (GNU tar) and macOS (bsdtar supports --null -T -). rsync would be simpler but isn't guaranteed on Windows, so the tar pipe is a reasonable choice.

Noting the portability dependency of the new recursive bundle step in the pre-push hook.


## Review 2026-07-08 (follow-up)

## Review 2026-07-08 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings

---

### [SR-20260708-022] [HIGH] shared/codex/app-server.mjs — Timed-out lock waiters break mutual exclusion for later callers

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Do not call the queue link's release function when a waiter times out before its predecessor has released. A timed-out waiter can reject its own returned promise, but its placeholder in the lock chain must still resolve only after `prev` resolves, so later callers remain behind the active holder. Add a regression test where A holds the lock, B times out, C is queued before A releases, and C must not start until A finishes.

In `withSharedClient`, the timeout rejection path calls `release()` at lines 239-243. That resolves B's `_lock` placeholder even though A, the previous lock holder, may still be running. Any caller that enters after B times out but before A completes takes `prev` as B's already-resolved placeholder and starts immediately, concurrently with A. The new tests only enqueue the next caller after A has completed, so they miss the actual serialization break.

---

### [SR-20260708-023] [HIGH] shared/spawn-child.mjs — onText line buffer is never flushed on child close — streaming loses tail of response

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a drain step before settle in the close handler: 'if (lineBuffer && onText) { try { const text = extractStreamText(JSON.parse(lineBuffer.trim())); if (text) onText(text); } catch {} }'. Add a test where the final chunk has no trailing newline.

The close handler (line 220-228) resolves with final output from parseStreamJsonOutput(stdout) without first draining lineBuffer to onText. If stdout's last chunk doesn't end with '\n', the partial JSON line stays in lineBuffer and never reaches the streaming callback. The test at shared/tests/spawn-child.test.mjs:162-189 always appends '\n' to every chunk, so it cannot catch this. The reported fix for SR-20260708-015 (line buffering) is incomplete: it handles chunk-boundary splits but not end-of-stream flush. parseStreamJsonOutput correctly re-parses the full stdout, so returned result.text is fine — but takeover's live stderr streaming silently loses the last content block.

---

### [SR-20260708-024] [HIGH] shared/anthropic-http.mjs — SSE body read loop has no timeout — server hang mid-stream blocks indefinitely

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Pass a signal (or rearm the AbortController) to the fetch Response body reader so mid-stream hangs time out after a reasonable period (e.g., 5 minutes). Alternatively, have parseSSEStream accept an AbortSignal or implement a per-read watchdog.

The 5-minute AbortController timeout (line 58-63) is cleared at line 89 after the initial fetch succeeds, before parseSSEStream is entered. Inside parseSSEStream (line 116-157), the reader.read() loop has zero timeout. A server that connects, sends HTTP headers, starts an event stream, and then hangs mid-generation (e.g., upstream crash after content_block_delta) causes the caller to hang forever. The timeout covers only the HTTP handshake, not the SSE body lifetime. This is architecturally distinct from SR-20260708-014 (which was about the retry loop failing to disable streaming) and SR-20260708-020 (spawn timeout).

---

### [SR-20260708-025] [MEDIUM] takeover/scripts/lib/spawn.mjs — spawnClaudeP silently drops most spawnChild parameters — timeoutMs, runDir, observe, cwd are inaccessible

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Forward relevant opts to spawnChild: 'const { provider, model, systemPrompt, images, configPath, signal, timeoutMs, runDir, observe, cwd, extraArgs } = opts;'. At minimum, forward timeoutMs so callers can tune per-use-case.

The function destructures only 6 fields from opts: provider, model, systemPrompt, images, configPath, signal. timeoutMs is always 600000 (hardcoded, line 32), with no forwarding path for callers who want a shorter or longer timeout. runDir, observe, cwd, extraArgs are similarly not forwarded. If a takeover caller wants custom isolation or observe mode, the only option is to bypass spawnClaudeP and call spawnChild directly. The hardcoded 600s timeout means a deep multi-turn claude session (large images, long thinking) gets killed before it finishes, with no rescue.

---

### [SR-20260708-026] [MEDIUM] shared/spawn-child.mjs — Non-streaming (short-prompt) mode always returns usage: null — direct spawnChild consumers lose cost data

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either (a) always use stream-json output format (remove the short-path optimization and accept the overhead) — making usage universally available; or (b) document that usage is null for prompts under 1000 chars and callers should fall back to stderr parsing for cost tracking. Option (a) is simpler and the overhead is negligible for modern machines.

The close handler (line 220-228) returns usage: null for non-stream-json output (short prompts under 1000 chars). Only stdin-based stream-json mode parses usage from the structured output. While takeover's wrapper (spawnClaudeP) compensates with extractUsageFromStderr, direct consumers like fabric's MCP run_task or any library-level spawnChild() call will always get null usage for short prompts. This is a silent contract limitation: usage is part of the return type but gated on prompt length.

---

### [SR-20260708-027] [MEDIUM] shared/tests/spawn-child.test.mjs — onText cross-chunk test can never catch the no-trailing-newline bug — test blind spot

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a second test where the final chunk omits the trailing newline. Assert onText receives both 'split-text' and 'tail'.

The test at line 162-189 appends '\n' to every chunk. Since every line in every chunk is newline-terminated, the line buffer is always empty at close time — the test never exercises the end-of-stream drain path. The test verifies cross-chunk splitting but masks the fact that the 'fix' is incomplete.

---

### [SR-20260708-028] [MEDIUM] shared/spawn-child.mjs — resolveClaudeExe walks PATH and stats files on every call — no caching for concurrent fan-out

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Memoize resolveClaudeExe with a module-level cache. The binary path doesn't change mid-session. If CLAUDE_CLI_PATH env var changes (unlikely), expose clearCache().

Every spawnChild call independently re-resolves the claude binary by splitting PATH, iterating directories, and testing existence of up to 4 shim names per directory. Fabric's primary use case is concurrent fan-out, so each call repeats the same I/O. On a cold cache or slow filesystem (Windows Defender, network PATH entries), this adds measurable latency proportional to concurrency.

---

### [SR-20260708-029] [LOW] fabric/.codex-plugin/plugin.json — Fabric .codex-plugin/plugin.json interface.defaultPrompt is a no-op placeholder

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace with something descriptive: e.g., 'Use the Fabric plugin to delegate tasks to DeepSeek, Codex, or other providers. Available tools: list_providers, resolve_model, run_task.'

interface.defaultPrompt is set to ["Use the Fabric plugin."] — a generic instruction that tells a Codex user nothing about what fabric does or how to invoke it. Since fabric exposes MCP tools (run_task, etc.), the default prompt should mention the available tools or link to documentation.

---

### [SR-20260708-030] [LOW] fabric/AGENTS.md — Fabric AGENTS.md doesn't mention passthroughAuth in MCP tool parameter table

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add 'passthroughAuth?' to the run_task parameters table and state that claude OAuth requires it when observe=true.

The MCP 'run_task' tool table lists parameters (provider, prompt, model?, observe?, write?, cwd?, runDir?) but omits passthroughAuth. The README's 'Auth note' says OAuth providers 'must use passthroughAuth: true'. If this parameter exists in the MCP tool but is undocumented, users won't know OAuth providers need it and will get auth failures.


## Review 2026-07-08 (follow-up)

## Review 2026-07-08 (session) — architecture hygiene (整洁锐评) + diff review

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260708-031] [HIGH] traceme/skills/traceme/SKILL.md — ~90% of this always-loaded skill file is a CLI man page with every flag variant inlined — worst progressive disclosure violation in the repo

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract the full CLI reference to reference/command-reference.md. Keep SKILL.md to ~30 lines: common commands (report today, rescan, dashboard, sync) with no more than one flag example each, and links to reference files. The date-format table (lines 106-131, 27 lines) should also be a link.

134 lines total; ~120 are CLI command examples. Each of 7 command sections (report, stats, status, sync, export, rescan, dashboard) lists every flag permutation inline: --json, --local, --brief, --project foo, --range 7d, --from --to, --csv, --all, --prune, --no-open, etc. The date-format block (lines 106-131) restates 15+ examples already covered earlier in the file. The reference/ directory has data-model.md (55 lines), sync.md (102 lines), dashboard.md (34 lines) — but none contain the CLI reference; it has no home outside SKILL.md. Every session that loads /traceme wastes ~800 tokens of low-signal text.

---

### [SR-20260708-032] [MEDIUM] cc-market/AGENTS.md + README.md — Plugin table, test command, adding-a-plugin guidance, and versioning description are substantially duplicated across AGENTS.md and README.md — two files with different scopes that will drift

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Make AGENTS.md the canonical source for the plugin table. In README.md, replace the plugin description table with a single-line 'See AGENTS.md for canonical descriptions' and keep only install commands. Remove the duplicated test command from README.md. Trim 'Adding a Plugin' duplication by making one file link to the other.

Both files have a 7-row plugin table, the same test command (nearly verbatim), 'Adding a Plugin' guidance, and automatic version bumping notes. This duplication already caused SR-20260708-031 (fabric missing from README table) — two copies mean double the maintenance burden.

---

### [SR-20260708-033] [MEDIUM] rem/skills/rem/SKILL.md — The Standard procedure (steps 0-4) and Lightweight procedure together occupy ~50 of 135 lines as a detailed walkthrough that should be in reference/

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move the Standard procedure (lines 88-131) and detailed Lightweight section (lines 82-86) to reference/standard-procedure.md. Keep SKILL.md to prune → crystallize/scope-split checks → fork → re-run rem-prep (~15 lines).

The Standard section is a 44-line step-by-step recipe (run rem-prep, review output, summarize, update memory, stamp, re-run rem-prep, update docs) that the scripts already handle. The 'summarize' subsection asks 3 meta-questions the agent should always answer. An always-loaded 135-line skill wastes context proportionally to detail density.

---

### [SR-20260708-034] [LOW] sharp-review/agents/sharp-review.md + skills/sharp-review/SKILL.md — The 11-line Windows CLAUDE_PLUGIN_ROOT fallback procedure is duplicated verbatim in both the agent prompt and SKILL.md, wasting platform-specific context on all non-Windows invocations

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Compress to 2-3 lines in both files. Move the full PowerShell fallback to reference/windows-troubleshooting.md. Have the agent prompt reference SKILL.md Step 0 instead of restating it.

Both files independently document the same 11-line PowerShell fallback for $env:CLAUDE_PLUGIN_ROOT. The agent is the runtime consumer — it doesn't need its own copy. On macOS/Linux, these commands are inert dead weight in both documents.

---

### [SR-20260708-035] [MEDIUM] shared/anthropic-http.mjs — SSE fallback on the final retry attempt falls out of the loop and callAnthropicAPI resolves with undefined instead of throwing

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** After the for loop, throw new Error('anthropic-http: retries exhausted') as a backstop, or restructure so the SSE-fallback `continue` cannot skip past the last attempt (e.g. don't consume an attempt for the streaming→non-streaming downgrade).

In callAnthropicAPI (line 48-114), the SSE-failure branch does `useStream = false; continue;`. Every other exit path either returns or throws, but if the SSE failure happens on attempt === maxRetries (e.g. two network-error retries followed by a stalled stream, now reachable since the fallback is live after the SR-014 fix), `continue` increments attempt past maxRetries, the loop exits, and the function returns undefined. Callers then hit `undefined.content` or silently treat the call as empty. Replicated into all bundled copies. The pre-fix code had the same structural hole but the path was dead; making the fallback work made this reachable.

---

### [SR-20260708-036] [MEDIUM] fabric/scripts/mcp-server.mjs — run_task documents cwd for all providers but the non-codex path never forwards it to spawnChild — the child silently runs in a temp runDir instead

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Forward `cwd: args.cwd` in the spawnChild call (spawnChild already supports it), or scope the schema description to codex-only like `write` is.

The inputSchema (line 72) says cwd 'Working dir for the child... Defaults to the server cwd', but the spawnChild call (line 101-104) passes only provider/prompt/model/observe/passthroughAuth/runDir. spawnChild then defaults cwd to runDir — a freshly created `fabric-task-<ts>` temp dir — so a caller who passes cwd expecting the child to see their repo gets a child running in an empty temp directory, with no error. This call site was edited in this commit to thread passthroughAuth; cwd was left behind. Same gap for timeoutMs: run_task has no timeout knob and inherits spawnChild's 120s default, which the new takeover wrapper considered too short (it uses 600s).

---

### [SR-20260708-037] [LOW] shared/spawn-child.mjs — Universal stream-json output means non-JSON stdout is now silently discarded in argv mode — a CLI failure that prints plain text to stdout yields stdout:'' with only the exit code to go on

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** In the close handler, when code !== 0 and parseStreamJsonOutput produced no text, fall back to the raw stdout (e.g. `stdout: parsed.text || (code !== 0 ? stdout.trim() : '')`). Also note the change is only mock-tested — no test runs the real `claude` binary to confirm `-p <prompt> --output-format stream-json` is accepted in argv mode.

Before this commit, argv (short-prompt) mode returned raw stdout verbatim. Now every close path runs parseStreamJsonOutput (line 247-252), whose per-line JSON.parse has an empty catch — any non-NDJSON output (CLI usage errors, version-mismatch banners, a provider gateway returning HTML) is dropped entirely. fabric's run_task then reports '(no output)'. The stream-json format itself has only ever been exercised through the stdin path in production and through fake spawns in tests.

---

### [SR-20260708-038] [LOW] takeover/scripts/lib/spawn.mjs — Header comment claims engine options 'pass through to spawnChild untouched' but the code forwards a hard-coded whitelist — passthroughAuth is already dropped, and every future spawnChild option will be too

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either spread the remainder (`const { provider, model, systemPrompt, images, signal, timeoutMs = 600000, ...rest } = opts;` then pass `...rest`), or fix the comment to say exactly which options are forwarded. The current comment/code mismatch is the same drift pattern this repo's invariants warn about.

The SR-025 fix forwarded timeoutMs/runDir/observe/cwd/extraArgs, and the new comment (lines 4-5) generalizes that to 'Engine options ... pass through to spawnChild untouched'. That is false: passthroughAuth — added to spawnChild in this same commit and needed the moment a takeover caller combines observe with a non-default auth mode — is not in the destructure and silently vanishes. onText is also unconditionally overridden with the stderr writer, which the comment doesn't mention.

---

### [SR-20260708-039] [INFO] shared/anthropic-http.mjs — Stall-triggered non-streaming fallback re-issues the full request: partial text already streamed to stderr is duplicated and the tokens are paid twice

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Acceptable trade-off for correctness; just be aware that on a stall after substantial output, the caller's stderr shows the text twice and the provider bills two generations. If it becomes a problem, prefer failing with the accumulated partial text instead of retrying.

parseSSEStream writes text_delta chunks to stderr as they arrive (line 178). When the idle watchdog fires mid-generation, callAnthropicAPI discards everything accumulated and retries non-streaming; the final answer is regenerated from scratch. Noting for the record since the new watchdog makes this path much more likely to actually execute than the previously-dead fallback.

---

### [SR-20260708-040] [INFO] shared/anthropic-http.mjs — callAnthropicAPI is now 7 positional parameters plus a trailing options bag — the signature is past the point where it should be a single options object

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Next time this signature grows, convert to callAnthropicAPI({ providerConfig, model, systemPrompt, userPrompt, images, stream, signal, sseIdleTimeoutMs }) and update the handful of call sites — backward compat is explicitly not a concern in this repo.

This commit added `{ sseIdleTimeoutMs }` as an 8th slot after `images = null, stream = false, signal = null`. Call sites already pass runs of nulls/booleans by position (see the new test: `..., null, true, null, { sseIdleTimeoutMs: 50 }`), which is exactly the readability failure an options object avoids.


## Review 2026-07-08 (follow-up)

## Review 2026-07-08 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings

---

### [SR-20260708-041] [LOW] shared/spawn-child.mjs — Raw-stdout fallback misclassifies valid empty stream-json output as unparsable

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Have parseStreamJsonOutput return a sentinel such as parsedAny/parsedResult, and fall back to raw stdout only when no valid stream-json messages were parsed.

The new close handler uses `parsed.text || stdout.trim()`. That fixes non-NDJSON banners, but it also treats a valid stream-json response with empty text, for example a `result` message with `result: ""` and usage, as a parse failure. In that case callers receive raw NDJSON instead of an empty model response, which can leak protocol output through fabric/takeover and break consumers expecting plain text.


## Review 2026-07-08 (follow-up)

## Review 2026-07-08 (session) — security audit (安全锐评) + architecture hygiene (整洁锐评)

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): skipped
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260708-042] [MEDIUM] shared/spawn-child.mjs — parsedAny is set by ANY parseable JSON line, not just stream-json messages — JSON-formatted error output is now silently dropped instead of falling back to raw stdout

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Only set parsedAny when the parsed line is a recognized stream-json message (e.g. typeof msg === 'object' && msg !== null && typeof msg.type === 'string', or restrict to the known types: assistant/result/system/user). Add a test for a JSON error body on stdout.

parseStreamJsonOutput sets parsedAny = true immediately after JSON.parse(line) succeeds, before checking anything about the message shape. Any valid JSON line qualifies: a gateway/proxy JSON error body ({"error":{"message":"invalid api key"}}), a CLI error emitted as JSON, or even a bare primitive like 123 or a quoted string. Such a line yields parsedAny=true and text='', so spawnChild now resolves with stdout: '' — the error content is silently discarded. Under the previous code (parsed.text || stdout.trim()) that same output fell back to raw stdout and was visible to the caller. So this change fixes the empty-NDJSON misclassification (SR-041) but reintroduces the exact silent-drop failure mode the fallback comment describes, for the case where the failing upstream speaks JSON rather than plain text. The inline comment ('any valid stream-json message seen') is also inaccurate — it's any valid JSON line. Fix by gating parsedAny on msg being an object with a string .type, so JSON-shaped errors still trigger the raw fallback. Applies to all 7 bundled copies.


## Review 2026-07-08 (follow-up)

## Review 2026-07-08 (session) — diff review (convergence check) + diff review (convergence check)

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings
