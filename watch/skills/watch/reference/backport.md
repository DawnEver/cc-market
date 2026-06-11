# Backport Procedure (deploy branch ahead of main)

Triggered when `report.components.git_version.metrics.deploy_ahead_total > 0`
(anomaly type `deploy_ahead_of_main`). This means a hotfix was committed directly
to the deploy branch and is missing from main.

1. **Check per-repo status**: Read `report.components.git_version.metrics` for
   `<repo>_deploy_ahead` counts and `report.components.git_version.data.<repo>_deploy_ahead_pending`
   for the pending commit subjects.

2. The `backport_deploy` action runs via the remedy plan in
   `report.anomalies[].remedy_plan` if `deploy_ahead_of_main` exists. Execute it via:
   ```bash
   python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
     --project-dir ${CLAUDE_PROJECT_DIR} \
     --action backport_deploy
   ```
   Internally, per repo where deploy is ahead of main:
   - No-op unless `deploy.enable_backport: true` is set for that repo's component config.
   - Creates an isolated worktree of `origin/<branch>` (main) and merges
     `origin/<deploy_branch>` into it (fast-forward when possible).
   - On merge conflict: aborts the merge, leaves main untouched, reports the repo
     in `backport_failed_repos`.
   - Runs the repo's `test_command` in the worktree.
   - On test failure: leaves main untouched, reports the repo in `backport_failed_repos`.
   - On success: pushes the merged result to `origin/<branch>` (main) directly —
     **no confirmation step**, this is the automated equivalent of a manual
     `git merge deploy && git push`.

3. **After backport runs**: check `--action backport_deploy` JSON output.
   - `backport_result: passed` and `backport_repos` lists the repos whose main
     branch was updated.
   - `backport_result: failed` — read `backport_failure_reason` and
     `backport_failed_repos`. These repos need a manual merge; report to the user.

4. Report to the user: which repos were backported, and any that need manual
   attention.

After this, go to Step 5 (schedule next check with `normal` interval).
