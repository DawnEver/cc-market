---
name: cli-utf8-stdio
description: bootstrap.ensure() forces UTF-8 stdio so CLI report glyphs (✓, —) don't crash on Windows cp1252 — fixed empty /watch:check output. v1.0.42.
metadata:
  type: project
---

watch **v1.0.42**. Same commit, contemporaneous with [[action-start-dir-env]].

### Symptom
`/watch:check` (runs `watch.py --json`) **produces blank output** on the Windows console. Both `--json` and the human
`_print_report` are affected.

### Root cause
Printing the status glyph `✓` (✓) / em-dash `—` to the default **cp1252** stdout raises `UnicodeEncodeError`
→ the process crashes, and a caller capturing stdout (the Bash tool) sees only an empty string.

### Fix
`scripts/bootstrap.py` adds `_force_utf8_io()`, called once at the top of `ensure()`:
`reconfigure(encoding='utf-8', errors='replace')` on `sys.stdout`/`sys.stderr`,
degrading to a no-op on `(AttributeError, ValueError)`. Because **every** CLI + daemon entry point does
`import bootstrap; bootstrap.ensure()` (and runs it again after re-exec into the venv), one place fixes all.
`errors='replace'` guarantees no crash even on unmappable characters.

### Tests
`tests/test_bootstrap.py` (3): reconfigured to utf-8 / writing an unmappable glyph does not raise / degrades when there is no reconfigure attribute.
> The fixture replacing `sys.stdout` interferes with pytest output capture in a full run — run that file alone, or in a full run
> `--ignore=tests/test_bootstrap.py` and then run it alone.

### Aside
`test_components_progress.py::test_complete_status_end_to_end` is order/timing flaky (passes in isolation).

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
