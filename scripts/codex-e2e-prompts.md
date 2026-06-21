# Codex E2E — manual `codex exec` prompts

`scripts/codex-e2e.sh` already covers what runs **headless without login**: manifest
validation, `marketplace add`, `plugin add`, and `${CLAUDE_PLUGIN_ROOT}` preservation in the
installed `.mcp.json`. The checks below need an **authenticated Codex** (`codex login`) and a
real `codex exec` turn, so they're driven by hand. They confirm the runtime gaps flagged in
`.claude/memory/2026/06/21/codex-support.md` §7.5: hook trust + session_start/stop firing, MCP
tool discoverability, and `.claude/rules` injection.

> Run everything in an **isolated `CODEX_HOME`** so your real config is never touched.
> Replace `<REPO>` with the absolute path to this `cc-market` checkout.

## 0. Isolated install (shell)

```bash
export CODEX_HOME="$(mktemp -d)/home"; mkdir -p "$CODEX_HOME"
cd <REPO>
node scripts/gen-codex.mjs .                 # regenerate Codex artifacts from source of truth
codex plugin marketplace add "$PWD"
codex plugin add takeover@cc-market
codex plugin add rem@cc-market
codex plugin add sharp-review@cc-market
codex plugin add evolve@cc-market
codex plugin list                            # expect all four enabled
```

When prompted to **trust** each plugin's hooks (hash approval — §7.3), accept. Note whether
the prompt is interactive only or scriptable; record the answer back into §7.5 of the design memo.

## 1. takeover MCP — tool discoverability (§7.5 q2)

Confirms the MCP server starts under Codex and `${CLAUDE_PLUGIN_ROOT}` resolves to the install
cache at runtime.

```
codex exec 'List the MCP tools you can call. Then call the takeover list_models tool and show its raw result.'
```

**Pass:** `call_model` / `list_models` / `codex_status` appear and `list_models` returns JSON
(not a "tool not found" / spawn error).

## 2. rem — SessionStart `.claude/rules` injection + Stop gate

Run inside a throwaway project that has a `.claude/rules/` file, so the injection has something
to surface:

```bash
proj="$(mktemp -d)"; mkdir -p "$proj/.claude/rules"
printf '# Probe rule\nAlways say PROBE-RULE-OK when asked about project rules.\n' > "$proj/.claude/rules/probe.md"
cd "$proj"
codex exec 'What do my project rules tell you to say? Answer with the exact phrase.'
```

**Pass (SessionStart `inject-rules.js`):** the model answers `PROBE-RULE-OK`, proving the rule
file was injected as additionalContext (Codex does not auto-load `.claude/rules`).

**Pass (Stop gate):** after a substantive multi-stop session, `rem-hook.js` eventually gates
for `/rem`. Verify it does **not** fire mid-turn (no `background_tasks` field on Codex → it must
fall back to the `taskActiveUntil` window, §7.6c).

## 3. sharp-review — host-adaptive raw fan-out (Step 3b)

In a project with a few committed changes:

```
codex exec 'Run a sharp review of the current changes.'
```

**Pass:** the skill takes the **Codex branch** — fans out reviewers via `spawn_agent` / takeover
`call_model` (NOT the `Workflow` tool, which Codex lacks), writes a `raw.json`, and calls
`post-review.js --raw`. Confirm `.claude/memory/<today>/sharp-review.md` is written with
`SR-<date>-NNN` ids and a Reviewer Status block — byte-identical in shape to the Claude path.

## 4. evolve — one round under Codex

```
codex exec '/evolve --until 1 --dry-run'
```

**Pass:** step 1 critique invokes the sharp-review skill directly (raw fan-out, not `Workflow`),
step 2 fans out fixes via `spawn_agent` per disjoint group, and `taskActiveUntil` is set at round
start so the Stop hook holds off until the round completes.

## 5. Cross-host parity (optional)

Run the same sharp-review prompt under `claude -p` in a temp `CLAUDE_HOME` and diff the produced
`sharp-review.md` structure against the Codex run — same ids, same status block, same
merge/dedup. Any divergence means the shared `mergeFindings`/`renderReviewMarkdown` path was
bypassed on one host.

---

### What a green run proves
- `${CLAUDE_PLUGIN_ROOT}` resolves at runtime on Codex (MCP + hook commands).
- Codex `session_start` / `stop` hooks fire and respect the trust + pending-work model.
- `.claude/rules` reaches the model on Codex via the rem injection hook.
- sharp-review / evolve produce identical artifacts on both hosts through the shared merge lib.

Record outcomes (especially the hook-trust automation question and any `${CLAUDE_PLUGIN_ROOT}`
miss) back into `.claude/memory/2026/06/21/codex-support.md` §7.5.
