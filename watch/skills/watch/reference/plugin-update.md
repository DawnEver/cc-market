# watch — Step 4b: Plugin self-update check

Read this on a `healthy` sweep to handle the rare case where the watch plugin's own version
drifted. Skip it entirely when there's no drift (the common case).

The watch plugin runs from a **versioned cache dir** the marketplace can bump out-of-band, so the
version watchd executes may change silently between sweeps. On each `healthy` sweep, detect drift:

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/plugin_version.py \
  --project-dir ${CLAUDE_PROJECT_DIR} --json
```

- `drift: false` → nothing to do (first run records no baseline — not drift).
- `drift: true` (`last_seen` → `current` differ) → a new plugin version is installed:
  1. `/reload-plugins` so this session picks up the new skill/scripts.
  2. Re-exec watchd against the new version — spawn it **detached** via `start-server.py` (a bare
     `daemon.py` runs the blocking poll loop in the foreground and would hang the session).
     `--force` replaces the daemon holding the pidfile; `${CLAUDE_PLUGIN_ROOT}` now resolves to the
     new cache dir:
     ```bash
     python ${CLAUDE_PLUGIN_ROOT}/scripts/helpers/start-server.py \
       --project-dir ${CLAUDE_PROJECT_DIR} \
       --cmd "python ${CLAUDE_PLUGIN_ROOT}/scripts/daemon/daemon.py --project-dir ${CLAUDE_PROJECT_DIR} --force"
     ```
  3. Record the new baseline so it isn't re-triggered:
     `python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/plugin_version.py --project-dir ${CLAUDE_PROJECT_DIR} --record`
