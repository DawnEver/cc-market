#!/usr/bin/env sh
# Quick-start: fabric node server + management console together, in THIS terminal.
# Session-bound on purpose - closing the window stops both. Usage: scripts/up.sh
exec node "$(dirname "$0")/up.mjs" "$@"
