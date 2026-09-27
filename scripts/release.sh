#!/usr/bin/env bash
# Explicit, fail-closed release. Creates a commit and annotated tag, but never pushes.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "release: working tree and index must be clean" >&2; exit 1; }
git symbolic-ref -q HEAD >/dev/null || { echo "release: detached HEAD is not supported" >&2; exit 1; }
original_head="$(git rev-parse HEAD)"
market_version="$(node -p "require('./.claude-plugin/marketplace.json').version")"
if [ "$(git rev-list -n 1 "v${market_version}" 2>/dev/null || true)" = "$original_head" ]; then
  echo "release: HEAD is already release v${market_version}" >&2
  exit 1
fi
completed=0
rollback() {
  status=$?
  if [ "$completed" -ne 1 ]; then
    git reset --hard "$original_head" >/dev/null
    git clean -fd -- .agents/plugins/marketplace.json */.codex-plugin */shared >/dev/null
    echo "release: failed; restored clean checkout at $original_head" >&2
  fi
  exit "$status"
}
trap rollback EXIT INT TERM

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [ -n "$upstream" ]; then base="$(git merge-base HEAD "$upstream")"
else base="$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)"; fi
changed="$(git diff --name-only "$base..HEAD")"
plugins=(); shared_changed=0
printf '%s\n' "$changed" | grep -q '^shared/' && shared_changed=1 || true
for dir in */; do
  name="${dir%/}"; [ -f "$name/.claude-plugin/plugin.json" ] || continue
  if [ "$shared_changed" -eq 1 ] || printf '%s\n' "$changed" | grep -q "^${name}/"; then plugins+=("$name"); fi
done
[ "${#plugins[@]}" -gt 0 ] || { echo "release: no plugin changes since $base" >&2; exit 1; }

bump_json() {
  node -e "const fs=require('fs'),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));const v=j.version.split('.').map(Number);j.version=[v[0],v[1],v[2]+1].join('.');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');process.stdout.write(j.version)" "$1"
}
uses_shared() { grep -rqE "from[[:space:]]+['\"][^'\"]*shared/[^'\"]+['\"]" --include='*.mjs' --include='*.js' --exclude-dir=tests --exclude-dir=shared --exclude-dir=node_modules "$1" 2>/dev/null; }
bundle_shared() {
  local name="$1" dest="$1/shared" tmp
  if ! uses_shared "$name"; then rm -rf "$dest"; return; fi
  tmp="$(mktemp -d)"
  (cd shared && find . -name tests -prune -o -name '*.mjs' -print0 | tar --null -T - -cf -) | tar -C "$tmp" -xf -
  rm -rf "$dest"; mv "$tmp" "$dest"
}

for name in "${plugins[@]}"; do bundle_shared "$name"; echo "release: $name v$(bump_json "$name/.claude-plugin/plugin.json")"; done
market_version="$(bump_json .claude-plugin/marketplace.json)"
node scripts/gen-codex.mjs . >/dev/null
node --test fabric/tests/*.test.mjs rem/tests/*.test.mjs sharp-review/tests/*.test.mjs \
  evolve/tests/*.test.mjs traceme/tests/*.test.mjs cc-latex/tests/*.test.mjs \
  shared/tests/*.test.mjs tests/*.test.mjs
if printf '%s\n' "${plugins[@]}" | grep -qx watch; then
  command -v uv >/dev/null 2>&1 || { echo "release: watch requires uv" >&2; false; }
  uv run --no-project --with-requirements watch/requirements.lock \
    python -m unittest discover watch/tests/
fi
if printf '%s\n' "${plugins[@]}" | grep -qx cc-academia; then
  command -v uv >/dev/null 2>&1 || { echo "release: cc-academia requires uv" >&2; false; }
  (cd cc-academia && uv run ruff check . && uv run python -m pytest -q)
fi

git add .claude-plugin/marketplace.json .agents/plugins/marketplace.json
for name in "${plugins[@]}"; do
  # Stage generated additions and removals alike. Claude-only plugins deliberately have no
  # .codex-plugin directory, and gen-codex may remove a stale one during this release.
  git add -A -- "$name"
done
git commit -m "chore(release): v${market_version}"
[ ! -e ".git/refs/tags/v${market_version}" ] && ! git rev-parse -q --verify "refs/tags/v${market_version}" >/dev/null || { echo "release: tag v${market_version} already exists" >&2; false; }
git tag -a "v${market_version}" -m "Release v${market_version}"
completed=1
trap - EXIT INT TERM
echo "release: created v${market_version}; review it, then run: git push --follow-tags"
