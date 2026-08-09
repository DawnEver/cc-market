@echo off
rem Quick-start: run this machine as a fabric LAN node, in THIS terminal.
rem Session-bound on purpose (user directive 2026-08-09) - never a background
rem service: closing the window stops the node. Usage: scripts\serve.cmd [--port N]
node "%~dp0serve.mjs" %*
