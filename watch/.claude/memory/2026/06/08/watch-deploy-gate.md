---
name: watch-deploy-gate
description: Deploy branch isolation, test port gate, multi-repo tracking, temp file conventions
metadata:
  type: project
---

## Watch Plugin — Deploy Gate & Multi-Repo

6 files changed in `cc-market/watch`:

### `scripts/start-server.py` — `--log LOGFILE`
Optional arg. When set, stdout/stderr append to file instead of DEVNULL. Auto-creates parent dir. Backward compat (defaults to DEVNULL).

### `components/git_version.py` — 4-phase deploy + per-repo metrics
- **check()**: emits `metrics[f'{name}_new_commits']` per repo, stores `state['_git_new_repos']`
- **_deploy()**: Phase 1 (Filter — only changed repos) → Phase 2 (Test — worktree per repo, per-repo test_command) → Phase 3 (Apply — `git checkout deploy && git reset --hard`) → Phase 4 (Gate — start test instance, health-check via `_health_check_url()`, kill; revert on failure)
- **_health_check_url()**: polls URL with `urllib.request`, catches `(URLError, OSError, socket.timeout)`, uses `with urlopen() as resp:`, accepts 2xx range
- Worktree cleanup in all code paths (success + failure)

### `core/config.py` — deploy defaults + validation
```python
'deploy': { 'enable_test_gate': False, 'test_health_url': '', ... }
_validate_config() — if enable_test_gate, require all 3 companion fields
```

### `core/actions.py` — registry injection
Injects `_registry` and `_project_dir` into context when delegating `__deploy__` etc. → lets `_deploy()` call `registry.get_action(name)`.

### `scripts/watch.py` — `--action` flag
`--action deploy|rollback|mark_stable` → `_execute_named_action()` → calls `git_version.execute_action()` directly without full check loop. Returns JSON with `deploy_branch_updated`, `test_health_passed`, `failure_reason`.

### `skills/watch/SKILL.md` — conventions
- Multi-Repo Deploy Awareness (per-repo metrics, independent worktrees)
- Logging & Temp File Convention (everything under `.claude/watch/logs/`)
- Deploy Branch History Hygiene (never commit fixes during deploy, linear FF-only)
- Updated healthy-path deploy decision tree with test port flow

### Also fixed (sharp review)
- `_health_check_url()`: specific exceptions, `with urlopen`, 2xx range
- `_validate_config()`: cross-field validation for test gate
- SKILL.md: "best-effort rollback" (was "atomic")
- Removed redundant metric assignment to `.data`
