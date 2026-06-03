#!/usr/bin/env bash
# Bump patch version of the marketplace manifest.
# Called by pre-push hook. Outputs new version on stdout.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKET_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"

NEW_VERSION=$(node -e "
var fs=require('fs'),p=process.argv[1];
var pkg=JSON.parse(fs.readFileSync(p,'utf8'));
var v=pkg.version.split('.').map(Number);
pkg.version=[v[0],v[1],v[2]+1].join('.');
fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
process.stdout.write(pkg.version);
" "$MARKET_JSON")

echo "bump-version: cc-market v${NEW_VERSION}" >&2
git -C "$REPO_ROOT" add "$MARKET_JSON"
echo "$NEW_VERSION"
