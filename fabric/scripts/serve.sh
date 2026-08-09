#!/usr/bin/env sh
# Quick-start: run this machine as a fabric LAN node, in THIS terminal.
# Session-bound on purpose (user directive 2026-08-09) — never a background
# service: closing the window stops the node. Usage: scripts/serve.sh [--port N]
exec node "$(dirname "$0")/serve.mjs" "$@"
