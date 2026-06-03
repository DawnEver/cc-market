#!/usr/bin/env bash
# Bump patch version in .claude-plugin/plugin.json.
# Called by pre-push hook. Outputs new version on stdout (last line).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_JSON="$PLUGIN_DIR/.claude-plugin/plugin.json"

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "bump-version: no plugin.json, skipping" >&2
  exit 0
fi

NEW_VERSION=$(node -e "
var fs=require('fs'),p=process.argv[1];
var pkg=JSON.parse(fs.readFileSync(p,'utf8'));
var v=pkg.version.split('.').map(Number);
pkg.version=[v[0],v[1],v[2]+1].join('.');
fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
process.stdout.write(pkg.version);
" "$PLUGIN_JSON")

echo "bump-version: takeover v${NEW_VERSION}" >&2
git -C "$(cd "$PLUGIN_DIR/.." && pwd)" add "$PLUGIN_JSON"
echo "$NEW_VERSION"
