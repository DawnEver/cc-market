"""Backport deploy-branch hotfixes to main — extracted from git_version.py."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from components.git_version import remove_worktree


def backport_deploy(comp_cfg: dict, project: Path, context: dict) -> bool:
    """Merge deploy-branch hotfixes back into main: worktree merge -> test -> push.

    For each repo where the deploy branch is ahead of main, merge it into a
    worktree of main, run the per-repo test_command, and push the merge
    result to origin/main if tests pass. Repos that conflict or fail tests
    are left untouched and reported via context for manual follow-up.
    """
    deploy_cfg = comp_cfg.get('deploy', {})
    if not deploy_cfg.get('enable_backport', False):
        print('[git_version] Backport gate disabled (deploy.enable_backport=false).')
        return True

    staging_base = project / deploy_cfg.get('staging_dir', '.watch-staging')
    test_cmd = deploy_cfg.get('test_command', '')
    deploy_branch = deploy_cfg.get('deploy_branch', 'deploy')
    repos = comp_cfg.get('repositories', [])

    overall_ok = True
    backported: list[str] = []
    failed: list[str] = []

    for repo in repos:
        name = repo['name']
        branch = repo.get('branch', 'main')
        remote = repo.get('remote', 'origin')
        repo_path = (project / repo['path']).resolve()
        if not repo_path.is_dir():
            continue

        try:
            main_head = subprocess.check_output(
                ['git', 'rev-parse', f'{remote}/{branch}'],
                cwd=repo_path, text=True, timeout=5).strip()
            deploy_head = subprocess.check_output(
                ['git', 'rev-parse', f'{remote}/{deploy_branch}'],
                cwd=repo_path, text=True, timeout=5).strip()
            ahead = int(subprocess.check_output(
                ['git', 'rev-list', '--count', f'{main_head}..{deploy_head}'],
                cwd=repo_path, text=True, timeout=5).strip())
        except Exception:
            continue

        if ahead == 0:
            continue

        staging = staging_base / 'backport' / name
        if staging.exists():
            remove_worktree(staging, repo_path)

        print(f'[git_version] [{name}] backport: {deploy_branch} is {ahead} '
              f'commit(s) ahead of {branch}')
        try:
            subprocess.run(
                ['git', 'worktree', 'add', '--detach', str(staging), main_head],
                cwd=repo_path, check=True, capture_output=True, text=True, timeout=30)
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] worktree FAILED: {e.stderr}')
            failed.append(name)
            overall_ok = False
            continue

        try:
            subprocess.run(
                ['git', 'merge', '--no-edit', deploy_head],
                cwd=staging, check=True, capture_output=True, text=True, timeout=60)
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] merge conflict: {e.stderr}')
            subprocess.run(['git', 'merge', '--abort'], cwd=staging,
                           capture_output=True, timeout=10)
            remove_worktree(staging, repo_path)
            failed.append(name)
            overall_ok = False
            continue

        repo_test_cmd = repo.get('test_command', test_cmd)
        tests_ok = True
        if repo_test_cmd:
            test_env = os.environ.copy()
            test_env['WATCH_PROJECT_ROOT'] = str(project)
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
            remove_worktree(staging, repo_path)
            failed.append(name)
            overall_ok = False
            continue

        try:
            subprocess.run(
                ['git', 'push', remote, f'HEAD:{branch}'],
                cwd=staging, check=True, capture_output=True, text=True, timeout=120)
            print(f'[git_version]   [{name}] pushed {deploy_branch} -> {branch} ({remote})')
            backported.append(name)
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] push FAILED: {e.stderr}')
            failed.append(name)
            overall_ok = False

        remove_worktree(staging, repo_path)

    context['backport_result'] = 'passed' if overall_ok else 'failed'
    context['backport_repos'] = ', '.join(backported) if backported else 'none'
    if failed:
        context['backport_failed_repos'] = ', '.join(failed)
        context['backport_failure_reason'] = (
            f'Backport failed for: {", ".join(failed)}. '
            f'main was NOT updated for these repos — manual merge required.'
        )

    return overall_ok
