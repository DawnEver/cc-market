"""Worktree-based deploy gate — extracted from git_version.py."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from components.git_version import (
    current_heads,
    health_check_url,
    load_known,
    remove_worktree,
    rollback_repos,
    save_known,
)


def deploy_repos(comp_cfg: dict, project: Path, context: dict) -> bool:
    """Worktree-based deployment gate with optional test-port verification.

    Phase 1: Filter — only deploy repos with new commits.
    Phase 2: Test  — worktree per changed repo, run per-repo test_command.
    Phase 3: Apply — fast-forward deploy branch to tested commit.
    Phase 4: Gate  — start test instance on alternate port, health-check,
               then signal ready for production swap (or revert on failure).
    """
    deploy_cfg = comp_cfg.get('deploy', {})
    staging_base = project / deploy_cfg.get('staging_dir', '.watch-staging')
    test_cmd = deploy_cfg.get('test_command', '')
    deploy_branch = deploy_cfg.get('deploy_branch', 'deploy')
    repos = comp_cfg.get('repositories', [])

    if not test_cmd or not repos:
        print('[git_version] No test_command or repositories configured.')
        return False

    # ── Phase 1: Get target commits, filter to only changed repos ──
    known = load_known(comp_cfg, project)
    new_heads: dict[str, str] = {}
    repos_to_deploy: list[dict] = []
    for repo in repos:
        name = repo['name']
        branch = repo.get('branch', 'main')
        remote = repo.get('remote', 'origin')
        repo_path = (project / repo['path']).resolve()
        if not repo_path.is_dir():
            continue
        try:
            target = subprocess.check_output(
                ['git', 'rev-parse', f'{remote}/{branch}'],
                cwd=repo_path, text=True, timeout=5,
            ).strip()
        except Exception:
            continue
        new_heads[name] = target
        if known.get(name) != target:
            repos_to_deploy.append(repo)

    if not repos_to_deploy:
        print('[git_version] All repos already at known-good. Nothing to deploy.')
        return True

    print(f'[git_version] Deploying {len(repos_to_deploy)} repo(s): '
          f'{", ".join(r["name"] for r in repos_to_deploy)}')

    # ── Phase 2: Worktree per changed repo, run per-repo test_command ──
    staging_dirs: dict[str, Path] = {}

    for repo in repos_to_deploy:
        name = repo['name']
        repo_path = (project / repo['path']).resolve()
        target = new_heads[name]
        staging = staging_base / name

        if staging.exists():
            remove_worktree(staging, repo_path)

        print(f'[git_version]   [{name}] worktree at {staging} ({target[:8]})')
        try:
            subprocess.run(
                ['git', 'worktree', 'add', '--detach', str(staging), target],
                cwd=repo_path, check=True, capture_output=True, text=True, timeout=30,
            )
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] worktree FAILED: {e.stderr}')
            for n, d in staging_dirs.items():
                remove_worktree(d, (project / next(
                    r['path'] for r in repos_to_deploy if r['name'] == n)).resolve())
            context['deploy_result'] = 'failed'
            context['deploy_failure_reason'] = f'Worktree creation failed for {name}'
            return False

        staging_dirs[name] = staging

    # Run per-repo test_command (or global fallback)
    tests_ok = True
    test_env = os.environ.copy()
    test_env['WATCH_PROJECT_ROOT'] = str(project)
    for repo in repos_to_deploy:
        name = repo['name']
        staging = staging_dirs[name]
        repo_test_cmd = repo.get('test_command', test_cmd)

        test_env['WATCH_STAGING'] = str(staging)
        env_key = 'WATCH_STAGING_' + name.upper().replace('-', '_').replace(' ', '_')
        test_env[env_key] = str(staging)

        print(f'[git_version]   [{name}] test: {repo_test_cmd}')
        t0 = time.time()
        try:
            r = subprocess.run(repo_test_cmd, shell=True, cwd=staging,
                               capture_output=True, text=True,
                               timeout=deploy_cfg.get('test_timeout', 300),
                               env=test_env)
            elapsed = time.time() - t0
            if r.returncode != 0:
                tests_ok = False
                print(f'[git_version]   [{name}] Tests FAILED ({elapsed:.0f}s)')
                if r.stdout:
                    print(r.stdout[-1500:])
                if r.stderr:
                    print(r.stderr[-1500:])
            else:
                print(f'[git_version]   [{name}] Tests PASSED ({elapsed:.0f}s)')
        except subprocess.TimeoutExpired:
            print(f'[git_version]   [{name}] Tests TIMED OUT')
            tests_ok = False

        if not tests_ok:
            break

    # ── Cleanup all worktrees ──
    for name, staging in staging_dirs.items():
        repo_path = (project / next(
            r['path'] for r in repos_to_deploy if r['name'] == name)).resolve()
        remove_worktree(staging, repo_path)

    if not tests_ok:
        context['deploy_result'] = 'failed'
        context['deploy_failure_reason'] = (
            'Tests failed in worktree staging. The deploy branch was NOT updated. '
            'The main service continues running from the previous known-good version.'
        )
        context['deploy_failed_commits'] = str({k: v[:8] for k, v in new_heads.items()})
        print(f'[git_version] Deploy ABORTED — tests failed.')
        return False

    # ── Phase 3: Fast-forward deploy branch for each changed repo ──
    print(f'[git_version] Applying to {deploy_branch} branch...')
    for repo in repos_to_deploy:
        name = repo['name']
        tracking_branch = repo.get('branch', 'main')
        repo_path = (project / repo['path']).resolve()
        target = new_heads[name]
        try:
            r = subprocess.run(['git', 'rev-parse', '--verify', deploy_branch],
                              cwd=repo_path, capture_output=True, timeout=5)
            if r.returncode != 0:
                subprocess.run(
                    ['git', 'checkout', '-b', deploy_branch, f'origin/{tracking_branch}'],
                    cwd=repo_path, check=True, capture_output=True, timeout=10)
            else:
                subprocess.run(['git', 'checkout', '-f', deploy_branch],
                              cwd=repo_path, check=True, capture_output=True, timeout=10)
            subprocess.run(['git', 'reset', '--hard', target],
                          cwd=repo_path, check=True, capture_output=True, timeout=10)
            print(f'[git_version]   [{name}] {deploy_branch} -> {target[:8]}')
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] FAILED: {e.stderr}')
            rollback_repos(comp_cfg, project)
            context['deploy_result'] = 'failed'
            context['deploy_failure_reason'] = f'Failed to update deploy branch for {name}'
            return False

    # Update known-good for ALL repos (including unchanged ones)
    save_known(comp_cfg, project, new_heads, stable_checks=0)
    context['deploy_result'] = 'passed'
    context['deploy_branch_updated'] = True
    print(f'[git_version] Deploy branch updated. Known-good saved (stable_checks=0).')

    # ── Phase 4: Test-port gate (optional) ──
    enable_test_gate = deploy_cfg.get('enable_test_gate', False)
    raw_url = deploy_cfg.get('test_health_url', '')
    if not enable_test_gate or not raw_url:
        print(f'[git_version] Test gate disabled — production restart delegated to SKILL.md.')
        return True

    # Normalise to list of gate dicts
    if isinstance(raw_url, str):
        raw_url = [raw_url]
    raw_start = deploy_cfg.get('test_start_action', '')
    raw_kill = deploy_cfg.get('test_kill_action', '')
    if isinstance(raw_start, str):
        raw_start = [raw_start] * len(raw_url)
    if isinstance(raw_kill, str):
        raw_kill = [raw_kill] * len(raw_url)
    gates = [
        {
            'health_url': u,
            'start_action': raw_start[i] if i < len(raw_start) else '',
            'kill_action': raw_kill[i] if i < len(raw_kill) else '',
        }
        for i, u in enumerate(raw_url)
    ]

    registry = context.get('_registry')
    prestart_sleep = deploy_cfg.get('test_prestart_sleep', 5)
    health_timeout = deploy_cfg.get('test_health_timeout', 30)

    for gate in gates:
        health_url = gate['health_url']
        start_action = gate.get('start_action', '')
        kill_action = gate.get('kill_action', '')

        if registry and start_action:
            start_act = registry.get_action(start_action) if hasattr(registry, 'get_action') else None
            if start_act:
                print(f'[git_version] Starting test instance via {start_action}...')
                from core.actions import _execute_action
                _execute_action(start_act, project, registry, '', context)
        time.sleep(prestart_sleep)

        print(f'[git_version] Health-checking test instance at {health_url}...')
        test_healthy = health_check_url(health_url, health_timeout)

        if registry and kill_action:
            kill_act = registry.get_action(kill_action) if hasattr(registry, 'get_action') else None
            if kill_act:
                from core.actions import _execute_action
                _execute_action(kill_act, project, registry, '', context)

        if not test_healthy:
            print(f'[git_version] Test instance health check FAILED at {health_url}')
            rollback_repos(comp_cfg, project)
            context['deploy_result'] = 'failed_test_health'
            context['deploy_failure_reason'] = (
                f'Test instance at {health_url} did not become healthy. '
                'Deploy branch reverted to known-good. Production service was NOT touched.'
            )
            return False

        print(f'[git_version] Test gate PASSED: {health_url}')

    context['deploy_test_health_passed'] = True
    print(f'[git_version] All test gates passed. Production restart delegated to SKILL.md.')
    return True


def verify_and_mark_stable(comp_cfg: dict, project: Path, context: dict) -> bool:
    """Verify local deploy-branch commits in an isolated worktree, then mark
    them known-good on success. Used by the `local_changes_unverified` remedy:
    a manual hotfix committed to the deploy branch gets tested before becoming
    the new rollback target. Known-good is left untouched on failure.
    """
    deploy_cfg = comp_cfg.get('deploy', {})
    test_cmd = deploy_cfg.get('test_command', '')
    repos = comp_cfg.get('repositories', [])
    if not test_cmd or not repos:
        print('[git_version] No test_command or repositories configured.')
        return False

    heads = current_heads(comp_cfg, project)
    known = load_known(comp_cfg, project)
    repos_to_test = [r for r in repos
                     if heads.get(r['name']) and heads.get(r['name']) != known.get(r['name'])]
    if not repos_to_test:
        print('[git_version] Local HEADs already match known-good. Nothing to verify.')
        return True

    staging_base = project / deploy_cfg.get('staging_dir', '.watch-staging')
    staging_dirs: dict[str, Path] = {}
    tests_ok = True
    test_env = os.environ.copy()
    test_env['WATCH_PROJECT_ROOT'] = str(project)

    for repo in repos_to_test:
        name = repo['name']
        repo_path = (project / repo['path']).resolve()
        target = heads[name]
        staging = staging_base / name

        if staging.exists():
            remove_worktree(staging, repo_path)
        try:
            subprocess.run(
                ['git', 'worktree', 'add', '--detach', str(staging), target],
                cwd=repo_path, check=True, capture_output=True, text=True, timeout=30,
            )
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] worktree FAILED: {e.stderr}')
            tests_ok = False
            break
        staging_dirs[name] = staging

        repo_test_cmd = repo.get('test_command', test_cmd)
        test_env['WATCH_STAGING'] = str(staging)
        env_key = 'WATCH_STAGING_' + name.upper().replace('-', '_').replace(' ', '_')
        test_env[env_key] = str(staging)

        print(f'[git_version]   [{name}] verify test: {repo_test_cmd}')
        t0 = time.time()
        try:
            r = subprocess.run(repo_test_cmd, shell=True, cwd=staging,
                               capture_output=True, text=True,
                               timeout=deploy_cfg.get('test_timeout', 300),
                               env=test_env)
            elapsed = time.time() - t0
            if r.returncode != 0:
                tests_ok = False
                print(f'[git_version]   [{name}] Tests FAILED ({elapsed:.0f}s)')
                if r.stdout:
                    print(r.stdout[-1500:])
                if r.stderr:
                    print(r.stderr[-1500:])
            else:
                print(f'[git_version]   [{name}] Tests PASSED ({elapsed:.0f}s)')
        except subprocess.TimeoutExpired:
            print(f'[git_version]   [{name}] Tests TIMED OUT')
            tests_ok = False

        if not tests_ok:
            break

    for name, staging in staging_dirs.items():
        repo_path = (project / next(
            r['path'] for r in repos_to_test if r['name'] == name)).resolve()
        remove_worktree(staging, repo_path)

    if not tests_ok:
        context['deploy_result'] = 'failed'
        context['deploy_failure_reason'] = (
            'Local deploy-branch changes failed verification tests. '
            'Known-good was NOT updated.')
        print('[git_version] Verify ABORTED — tests failed. Known-good unchanged.')
        return False

    save_known(comp_cfg, project, heads, stable_checks=0)
    context['deploy_result'] = 'passed'
    context['known_good_updated'] = True
    print('[git_version] Local changes verified. Known-good updated (stable_checks=0).')
    return True
