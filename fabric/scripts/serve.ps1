# Quick-start: run this machine as a fabric LAN node, in THIS terminal.
# Session-bound on purpose (user directive 2026-08-09) — never a background
# service: closing the window stops the node. Usage: .\scripts\serve.ps1 [-Port N]
param([int]$Port)
$root = Split-Path -Parent $PSScriptRoot
$args_ = @("$root\scripts\serve.mjs")
if ($Port) { $args_ += @('--port', $Port) }
node @args_
