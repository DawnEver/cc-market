#!/usr/bin/env bash
# E2E: validate every generated Codex manifest, then add the cc-market marketplace and install
# takeover — all in an isolated CODEX_HOME so the user's real config is untouched.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VALIDATOR="$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py"
PROBE="${TMPDIR:-/tmp}/codex-e2e"; rm -rf "$PROBE"; mkdir -p "$PROBE/home"
export CODEX_HOME="$PROBE/home"

echo "=== validate all generated manifests ==="
fail=0
for d in "$REPO"/*/.codex-plugin; do
  plug="$(dirname "$d")"
  if python3 "$VALIDATOR" "$plug" >/dev/null 2>&1; then
    echo "OK   $(basename "$plug")"
  else
    echo "FAIL $(basename "$plug")"; python3 "$VALIDATOR" "$plug" 2>&1 | sed 's/^/     /'; fail=1
  fi
done

echo "=== add cc-market marketplace (root=$REPO) ==="
codex plugin marketplace add "$REPO" 2>&1 | tail -3
echo "=== plugin list ==="
codex plugin list 2>&1 | tail -12
echo "=== install takeover ==="
codex plugin add takeover@cc-market 2>&1 | tail -4
echo "=== installed .mcp.json (CLAUDE_PLUGIN_ROOT preserved?) ==="
find "$CODEX_HOME/plugins/cache" -name .mcp.json -exec cat {} \; 2>/dev/null
exit $fail
