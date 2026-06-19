#!/usr/bin/env bash
# cc-market setup: configure git hooks path.
set -e

HOOKS_DIR="scripts/git-hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: run this from the cc-market repo root" >&2
  exit 1
fi

# core.hooksPath MUST stay relative. This repo is synced (e.g. via OneDrive) across
# machines with different user dirs, and the value lives in per-clone .git/config — an
# absolute path points at one machine's path and silently disables all hooks on the others
# (no pre-commit tests, no pre-push version bump/tag). Detect drift and reset, idempotently.
CURRENT="$(git config --get core.hooksPath || true)"

case "$CURRENT" in
  "$HOOKS_DIR")
    echo "cc-market: hooks already configured (core.hooksPath = $HOOKS_DIR)"
    ;;
  /*|[A-Za-z]:[\\/]*)
    git config core.hooksPath "$HOOKS_DIR"
    echo "cc-market: reset absolute core.hooksPath ($CURRENT) -> $HOOKS_DIR"
    ;;
  *)
    git config core.hooksPath "$HOOKS_DIR"
    echo "cc-market: hooks configured (core.hooksPath = $HOOKS_DIR)"
    ;;
esac
