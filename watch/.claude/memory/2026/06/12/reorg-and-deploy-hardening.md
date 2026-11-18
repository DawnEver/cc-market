---
name: reorg-and-deploy-hardening
description: Plugin moved to functional subpackages (scripts/cli|daemon|helpers, components/health|resources|versioning|progress) + deploy-safety hardening (atomic writes, locks, fetch classification, audit). New launch paths. Commit d8265c0.
metadata:
  type: project
---

cc-market `watch` commit **d8265c0** (after [[action-forms-and-core-dedup]]). File reorganization +
unattended-deploy hardening landed together. 144 tests pass (was 124, +20).

### New file layout (old flat paths are invalid)
```
scripts/bootstrap.py                 # still at scripts/ root (everyone imports it)
scripts/cli/    watch.py  send_alert.py  trigger-emit.py
scripts/daemon/ daemon.py (was watchd/daemon.py)  trigger-watch.py
scripts/helpers/ start-server.py  kill-server.py
components/base.py  registry.py     # still at root
components/health/    http_health  watchd_heartbeat  shell_probe
components/resources/ disk_usage  process_monitor  log_scanner
components/versioning/ git_version  git_version_deploy
components/progress/  progress_tracker
```
`watchd/` deleted. `registry.py` discovery changed to recursive `rglob('*.py')` (excluding `_*`/base/registry).
**Path references already synced**: `core/actions._SCRIPTS_DIR` (→scripts/helpers),
`trigger-watch.WATCH_PY` (→scripts/cli/watch.py), **`hooks/alert-hook.js`**
(→scripts/cli/send_alert.py; missing it would silently break alert mail), commands/*.md, README,
skills/reference/*, tests sys.path. The `parents[N]` depth of moved entrypoints is fixed
(cli=3 parents, daemon=`_HERE.parent.parent`). bootstrap did not move; `parent.parent`=root unchanged.
plugin.json is still **v1.0.31** — a structural change; bump on the next release.

### Deploy safety hardening (`core/state.py` + `components/versioning/*`)
- All state JSON (known-good / deploy_failures / monitor) switched to **atomic writes** (tmp+os.replace)
  + a cross-platform advisory file lock (O_CREAT|O_EXCL retry); concurrent watchd/trigger-watch/AI no longer lose updates.
- **Deploy-in-progress lock**: a concurrent second deploy exits cleanly; a stale lock is taken over by pid liveness.
- Worktree cleanup is idempotent + Windows backoff retry before falling back to rmtree.
- git fetch failures classified (auth/network/corrupt) into the fetch_unreachable message.
- Every deploy writes a structured audit → `logs/deploy.jsonl`.
- start-server adds a startup liveness probe + Windows STARTUPINFO; kill-server re-checks the port is freed after killing, netstat parsing made robust.
- Tests: `tests/test_process_control.py` etc. +20.

### Still not done (listed by review, not changed this round)
known-good multi-snapshot history rollback; dedup of anomaly counts tracked twice by daemon and AI loop;
unify precedence of the remedy chain declared in two places (component hardcoded vs config).

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
