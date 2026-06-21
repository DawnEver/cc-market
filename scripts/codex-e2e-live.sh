#!/usr/bin/env bash
# One-button Codex setup + smoke test for cc-market — RUN IT, COPY THE WHOLE OUTPUT BACK.
#
# This is a REAL install into your actual ~/.codex (no throwaway home): you said you don't mind
# the plugins persisting, so installing IS the test — the four §7.5 runtime checks (hook firing,
# MCP tool discoverability, ${CLAUDE_PLUGIN_ROOT} resolution, .claude/rules injection) get
# exercised here and again every time you use Codex normally afterwards.
#
# Installs the 4 in-scope plugins: takeover, rem, sharp-review, evolve.
#   (NOT watch — works but Notification degrades to Stop-only on Codex.  NOT traceme — unsupported.)
# Uninstall later, cleanly, with:  codex plugin remove <name>@cc-market
#
# Usage:  bash scripts/codex-e2e-live.sh        (run from the cc-market repo root; be logged in: `codex login`)
# Then copy everything between the BEGIN/END markers back to Claude.

set -uo pipefail   # NOT -e: every probe runs and reports, even if one fails.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp -t codex-e2e.XXXXXX).log"
exec > >(tee "$LOG") 2>&1   # mirror to a log file so nothing is lost to scrollback

echo "========================= CODEX SETUP+E2E — BEGIN (copy from here) ========================="
echo "repo:     $REPO"
echo "log file: $LOG"
echo "mode:     REAL install into ~/.codex (persists; remove with 'codex plugin remove <name>@cc-market')"

sec() { echo; echo "──────────── $1 ────────────"; }
verdict() { echo ">> EXPECT: $1"; }

# Portable timeout (macOS ships neither `timeout` nor `gtimeout` by default).
TIMEOUT_BIN=""
command -v timeout  >/dev/null 2>&1 && TIMEOUT_BIN="timeout"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_BIN="gtimeout"
run_to() { local secs="$1"; shift; if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi; }

# ── 0. Preconditions ──────────────────────────────────────────────────────────────────
sec "0. environment"
command -v codex >/dev/null 2>&1 || { echo "FAIL: codex CLI not on PATH."; echo "===== END ====="; exit 0; }
command -v node  >/dev/null 2>&1 || { echo "FAIL: node not on PATH."; echo "===== END ====="; exit 0; }
codex --version 2>&1 | grep -iv "PATH aliases" | head -1
echo "node: $(node --version)"
[ -f "$HOME/.codex/auth.json" ] && echo "auth: ~/.codex/auth.json present (logged in)" \
  || echo "WARN: not logged in — run 'codex login' first, else the exec probes (2–4) fail with an auth error."

# Non-interactive exec: bypass the one-time hook-trust prompt + approvals so probes don't hang.
# (Your normal interactive `codex` sessions will still ask you to trust the hooks once — that's fine.)
EXEC_FLAGS=(--dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check)

# ── 1. Generate artifacts + install the four plugins (REAL ~/.codex) ──────────────────
sec "1. generate Codex artifacts + install plugins (real)"
node "$REPO/scripts/gen-codex.mjs" "$REPO" 2>&1 | tail -3
codex plugin marketplace add "$REPO" 2>&1 | grep -iv "PATH aliases" | tail -3
for p in takeover rem sharp-review evolve; do
  echo "-- plugin add $p --"
  codex plugin add "$p@cc-market" 2>&1 | grep -iv "PATH aliases" | tail -2
done
echo "-- plugin list --"
codex plugin list 2>&1 | grep -iv "PATH aliases"
verdict "all four plugins listed + enabled; no install errors"

sec "1b. \${CLAUDE_PLUGIN_ROOT} preserved in the installed takeover .mcp.json"
find "$HOME/.codex/plugins" -name .mcp.json -exec sh -c 'echo "$1:"; cat "$1"' _ {} \; 2>/dev/null | head -30
verdict "the installed .mcp.json still contains \${CLAUDE_PLUGIN_ROOT} (Codex resolves it at runtime)"

# ── 2. MCP tool discoverability + plugin-root resolution ──────────────────────────────
sec "2. takeover MCP — list_models (proves MCP server boots + plugin root resolves)"
OUT2="$(mktemp)"
run_to 180 codex exec "${EXEC_FLAGS[@]}" -o "$OUT2" \
  'Call the takeover MCP tool named list_models with no arguments. Then reply with ONLY its raw JSON result. If no such tool is available to you, reply exactly: TOOL_NOT_FOUND.' \
  2>&1 | grep -iv "PATH aliases" | tail -8
echo "-- final message --"; [ -f "$OUT2" ] && cat "$OUT2" || echo "(none captured)"; rm -f "$OUT2"
verdict "JSON list of models (NOT 'TOOL_NOT_FOUND') → MCP server started under Codex and \${CLAUDE_PLUGIN_ROOT} resolved"

# ── 3. .claude/rules injection via rem SessionStart hook ──────────────────────────────
sec "3. rem inject-rules — SessionStart hook injects host .claude/rules (Codex-only)"
PROJ="$(mktemp -d -t codex-e2e-proj.XXXXXX)"; mkdir -p "$PROJ/.claude/rules"
printf '# Probe rule\nWhen asked about project rules, reply with the exact phrase: PROBE-RULE-OK-7Q.\n' > "$PROJ/.claude/rules/probe.md"
( cd "$PROJ" && git init -q 2>/dev/null; true )
OUT3="$(mktemp)"
run_to 180 codex exec "${EXEC_FLAGS[@]}" -C "$PROJ" -o "$OUT3" \
  'What do my project rules instruct you to say? Answer with the exact phrase only.' \
  2>&1 | grep -iv "PATH aliases" | tail -8
echo "-- final message --"; [ -f "$OUT3" ] && cat "$OUT3" || echo "(none captured)"; rm -f "$OUT3"
verdict "answer contains 'PROBE-RULE-OK-7Q' → SessionStart hook ran and injected .claude/rules (Codex does NOT auto-load them)"

# ── 4. Skill ingestion — sharp-review / evolve visible to Codex ───────────────────────
sec "4. skills ingested (sharp-review + evolve reachable on Codex)"
OUT4="$(mktemp)"
run_to 180 codex exec "${EXEC_FLAGS[@]}" -C "$PROJ" -o "$OUT4" \
  'List the names of the skills/plugins you can use that come from the cc-market marketplace. One per line. Do not run them.' \
  2>&1 | grep -iv "PATH aliases" | tail -8
echo "-- final message --"; [ -f "$OUT4" ] && cat "$OUT4" || echo "(none captured)"; rm -f "$OUT4"
verdict "sharp-review and evolve appear → skills ingested under Codex"

# ── 5. (heavy, opt-in) actually run a sharp review under Codex ─────────────────────────
# Spawns reviewer sub-agents/models — real cost. Uncomment to exercise the Codex raw fan-out
# (Step 3b) end-to-end and confirm it writes .claude/memory/<today>/sharp-review.md with SR- ids.
# sec "5. sharp-review live (Codex raw fan-out) — HEAVY"
# ( cd "$PROJ" && echo x > a.txt && git add -A && git commit -qm seed )
# run_to 600 codex exec "${EXEC_FLAGS[@]}" -C "$PROJ" 'Run a sharp review of the current repository.' 2>&1 | grep -iv "PATH aliases" | tail -20
# ls -1 "$PROJ/.claude/memory" 2>/dev/null && echo "→ check for SR- ids in the written sharp-review.md"

# ── Cleanup (temp probe project only — the plugins stay installed) ────────────────────
sec "cleanup"
rm -rf "$PROJ" && echo "removed temp probe project (plugins remain installed in ~/.codex)"
echo "to uninstall later:  for p in takeover rem sharp-review evolve; do codex plugin remove \$p@cc-market; done"
echo
echo "========================= CODEX SETUP+E2E — END (copy to here) ========================="
echo "(full log also saved at: $LOG)"
