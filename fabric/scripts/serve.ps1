# Quick-start: bring this machine up as a fabric member (LAN node + management console)
# in THIS terminal. Session-bound on purpose (user directive 2026-08-09) — never a
# background service: closing the window stops both.
# Usage: .\scripts\serve.ps1 [--port N] [--console-port N] [--no-console] [--status]
node "$PSScriptRoot\serve.mjs" @args
