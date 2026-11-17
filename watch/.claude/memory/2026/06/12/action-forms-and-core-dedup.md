---
name: action-forms-and-core-dedup
description: Declarative action forms (kill_port/start_cmd/steps) so config drops inline python-c glob boilerplate; + core dedup (pid_alive/log_event/_project_dir). Plugin commit 5e1082f.
metadata:
  type: project
---

cc-market `watch` commit **5e1082f**. Predecessor to [[reorg-and-deploy-hardening]].

### New declarative action forms (`components/base.py` + `core/actions.py`)
`Action` gains fields, handled by the executor in `_execute_action`, **backward compatible** with the old `kill`/`start`/`command`:
- **managed-service**: `kill_port` (int|str|list), `kill_pattern`, `start_cmd`, `start_dir`,
  `start_log` (the latter two relative to project-dir). The executor resolves from `Path(__file__).parents[..]/'scripts'/'helpers'`
  the bundled `kill-server.py`/`start-server.py`, and **no longer** globs `~/.claude/plugins/...`
  (install root / cache layout is fragile). New `_SCRIPTS_DIR`, `_run_script()`, `_exec_managed()`.
- **composition**: `steps: [action_name, ...]` runs other named actions in order (`registry.get_action`).
- Config parsing needs no change: `registry.py` already does `Action(**{k:v ... if k in __dataclass_fields__})`, so new fields are picked up automatically.
- The deploy gate also goes through `_execute_action` (`git_version_deploy._run_restart` / test_start/kill_action),
  so managed/steps are available in the deploy chain too.
- Tests `tests/test_actions.py` (5).

### Duplication removed
- `scripts/watch.py:_pid_alive` deleted → import `core.pidfile.pid_alive` (was a verbatim copy).
- The bodies of `daemon.py:_log` and `trigger-watch.py:_log` extracted to `core/log.py:log_event(
  project_dir, log_file, level, msg)`; both keep thin-signature adapters.
- `daemon.py:_load_config` wrapper deleted; `_project_dir` injection moved up into `core/config.py:load_config`
  (every caller gets it; previously only daemon injected it).
- README "Actions" section documents the three forms.

> Paths are as of commit 5e1082f; after [[reorg-and-deploy-hardening]] scripts moved to
> `scripts/cli|daemon|helpers`, components moved to `components/health|resources|versioning|progress`.

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
