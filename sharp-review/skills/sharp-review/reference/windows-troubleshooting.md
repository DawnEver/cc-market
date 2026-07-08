# Resolving CLAUDE_PLUGIN_ROOT (Windows fallback)

`$env:CLAUDE_PLUGIN_ROOT` is set by Claude Code when the plugin is installed, but may not be
inherited on some machines (in particular by subagent processes). Before running any
sharp-review script, resolve it:

```powershell
if (-not $env:CLAUDE_PLUGIN_ROOT) {
  $fallback = "$env:TEMP/claude-sharp-review/plugin-root.txt"
  if (Test-Path $fallback) {
    $env:CLAUDE_PLUGIN_ROOT = (Get-Content $fallback -Raw).Trim()
  }
}
```

If still empty after the fallback, report `CLAUDE_PLUGIN_ROOT is not set and no fallback found` and stop.
