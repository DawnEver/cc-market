# Deploy Procedure (on `healthy` with new commits)

Triggered when `report.watch.version_tracking.enabled` and
`report.components.git_version.data.new_commits > 0`.

1. **Check per-repo status**: Read `report.components.git_version.metrics` for per-repo
   commit counts (e.g., `wdg-lab_new_commits: 2`, `wdg-lab-webui_new_commits: 0`). Only
   repos with `> 0` new commits will be deployed.

2. The `deploy` action (worktree test gate) runs via the remedy plan in
   `report.anomalies[].remedy_plan` if `new_version_available` exists. Execute it via:
   ```bash
   python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
     --project-dir ${CLAUDE_PROJECT_DIR} \
     --action deploy
   ```
   Internally the deploy action:
   - Multi-repo: each repo independently checked. Creates an isolated worktree per
     changed repo. Any repo failure reverts ALL deploy branches to known-good.
   - Runs each repo's `test_command` (or the global default)
   - **Only deploys repos with new commits** — unchanged repos are skipped
   - Fast-forwards the deploy branch to the tested commit (`git reset --hard
     <tested-commit>`) — never commit fixes during deploy; hotfixes via normal PR flow
   - If `enable_test_gate: true`: starts a test instance on `test_health_url`,
     health-checks it, then kills it. Returns `deploy_test_health_passed: true`.
     **The production service is NOT touched during this phase.**
   - If tests or health check fail: reverts ALL deploy branches to known-good,
     production continues undisturbed. Read `failure_reason` for details.

3. **After deploy passes with test gate**: Check the `--action deploy` JSON output.
   If `test_health_passed: true`:
   - Restart the production service(s) on their production ports.
   - The restart actions now use `--log .claude/watch/logs/<name>.log` — check those
     logs if restart fails.

4. **If no test gate**: The deploy action returns `deploy_branch_updated: true` but does
   NOT restart services. You must restart production services yourself, verifying they
   come up healthy.

5. Report to the user: which repos were deployed, commit SHAs, test/health results.

Verify production state against `.claude/watch/known-good.json`.

After this, go to Step 5 (schedule next check with `normal` interval).
