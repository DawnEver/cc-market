# Deploy Procedure (one-way: main → known-good → deploy worktree)

Triggered when `report.watch.version_tracking.enabled` and
`report.components.git_version.metrics.new_commits > 0`.

**Model.** All development and testing happen on `main` (the watchd working tree).
A new main commit is tested in an isolated staging worktree; on pass it becomes
known-good and is pushed into a dedicated **deploy worktree** (`deploy_path`) that
runs production. The deploy branch is never hand-edited. There is no backport and
no hotfix-on-deploy.

1. **Per-repo status**: read `report.components.git_version.metrics` — `<name>_changed`
   marks repos whose remote `main` differs from known-good. Only changed repos deploy.

2. Run the `deploy` action (it is the remedy for `new_version_available`):
   ```bash
   python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
     --project-dir ${CLAUDE_PROJECT_DIR} --action deploy
   ```
   Internally:
   - Creates a staging worktree per changed repo at the new main commit. Repos with a
     `nest_into` are placed inside the host's worktree (e.g. lib at `usr/lib`) so the
     host's tests can import them.
   - Runs each repo's `test_command` in staging. If `enable_test_gate: true`, also
     starts a test instance from staging on `test_health_url`, health-checks, kills it.
   - **On pass**: `git reset --hard <commit>` in each repo's **deploy worktree**, then
     runs `production_restart_action` and health-checks `production_health_url`. If
     production is unhealthy it rolls the deploy worktrees back to known-good and
     restarts. On success: known-good is updated and the failure counter cleared.
   - **On any failure**: production is never touched (it keeps running the previous
     known-good). The failed target signature is recorded; the same commit is not
     retried — a *fresh* fix commit on main is required.

3. **Escalation**: when `metrics.failed_commits >= max_failed_commits` (default 3 distinct
   commits failed), `git_version` emits `deploy_failed` (critical) → alert email. The fix
   on main is not converging; a human must intervene.

4. **Runtime health problems** (production unhealthy, not a new version): the
   `recover_service` action restarts production up to `restart_attempts` times, then rolls
   back to known-good and restarts once more; if still unhealthy it escalates (known-good
   itself is not serving).

Verify production state against `.claude/watch/known-good.json`. Then go to Step 5
(schedule next check with `normal` interval).
