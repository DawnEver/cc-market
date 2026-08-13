@echo off
rem Quick-start: bring this machine up as a fabric member (LAN node + management console)
rem in THIS terminal. Session-bound on purpose (user directive 2026-08-09) - never a
rem background service: closing the window stops both.
rem Usage: scripts\serve.cmd [--port N] [--console-port N] [--no-console] [--status] [--force]
node "%~dp0serve.mjs" %*
rem A failure read must not vanish with the window (the double-click case: a flash-exit
rem was indistinguishable from a crash). Success keeps the old behavior.
if %errorlevel% neq 0 pause
