#!/usr/bin/env bash
# cc-market setup: configure git hooks path.
set -e

HOOKS_DIR="scripts/git-hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: run this from the cc-market repo root" >&2
  exit 1
fi

git config core.hooksPath "$HOOKS_DIR"
echo "cc-market: hooks configured (core.hooksPath = $HOOKS_DIR)"
