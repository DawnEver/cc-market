"""Multi-repo version tracking component — known-good snapshots, worktree deploy gate."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, CheckResult, Component, RemedyStep


class GitVersion(Component):
    name = 'git_version'
    description = 'Multi-repo version tracking — known-good snapshots, worktree test gate, rollback'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        """Check if new commits exist on remote vs known-good."""
        repos = comp_cfg.get('repositories', [])
        project = Path(global_cfg.get('_project_dir', '.'))
        result = CheckResult()

        if not repos:
            return result

        known = self._load_known(comp_cfg, project)

        # Load extra metadata from known-good.json for context
        kg_path = self._known_good_path(comp_cfg, project)
        kg_meta: dict = {}
        if kg_path.exists():
            try:
                kg_meta = json.loads(kg_path.read_text(encoding='utf-8'))
            except Exception:
                pass
        result.data['stable_checks'] = kg_meta.get('stable_checks', 0)
        result.data['last_updated'] = kg_meta.get('updated_at')

        total_new = 0
        details: list[str] = []

        for repo in repos:
            name = repo['name']
            branch = repo.get('branch', 'main')
            remote = repo.get('remote', 'origin')
            repo_path = (project / repo['path']).resolve()
            if not repo_path.is_dir():
                continue

            # Fetch
            try:
                subprocess.run(['git', 'fetch', remote], cwd=repo_path,
                               check=True, capture_output=True, timeout=30)
            except Exception:
                pass

            # Get remote HEAD
            try:
                remote_head = subprocess.check_output(
                    ['git', 'rev-parse', f'{remote}/{branch}'],
                    cwd=repo_path, text=True, timeout=5,
                ).strip()
            except Exception:
                continue

            known_commit = known.get(name)
            if known_commit:
                try:
                    ahead = subprocess.check_output(
                        ['git', 'rev-list', '--count', f'{known_commit}..{remote_head}'],
                        cwd=repo_path, text=True, timeout=5,
                    ).strip()
                    count = int(ahead)
                except Exception:
                    count = 0
            else:
                count = 1  # No known-good yet, treat as new

            if count > 0:
                total_new += count
                details.append(f'{name}: +{count}')
                result.data[f'{name}_new_head'] = remote_head
                # Fetch pending commit subjects for context
                if known_commit:
                    try:
                        log_out = subprocess.check_output(
                            ['git', 'log', '--oneline', f'{known_commit}..{remote_head}'],
                            cwd=repo_path, text=True, timeout=5,
                        ).strip()
                        result.data[f'{name}_pending'] = log_out.split('\n') if log_out else []
                    except Exception:
                        result.data[f'{name}_pending'] = []

            # Per-repo metric — lets the report and AI see each repo independently
            result.metrics[f'{name}_new_commits'] = count

        result.metrics['new_commits'] = total_new
        result.data['new_commits'] = total_new
        result.data['new_commits_detail'] = ', '.join(details) if details else 'none'
        state['_git_new_commits'] = total_new
        state['_git_detail'] = result.data['new_commits_detail']
        state['_git_new_repos'] = details

        if total_new > 0:
            result.anomalies.append(Anomaly(
                type='new_version_available', severity='warning',
                value=total_new,
                message=f'New commits on remote: {result.data["new_commits_detail"]}',
            ))

        return result

    def remedies(self) -> dict[str, list[RemedyStep]]:
        return {
            'new_version_available': [
                RemedyStep(action='deploy'),
            ],
        }

    def actions(self) -> dict[str, Action]:
        return {
            'deploy': Action(
                description='Worktree-based deploy: fetch -> test -> apply or reject',
                command='__deploy__',  # Special — handled by _deploy method
                timeout=600,
            ),
            'rollback': Action(
                description='Rollback all repos to known-good versions',
                command='__rollback__',
                timeout=60,
            ),
            'mark_stable': Action(
                description='Mark current HEAD as known-good',
                command='__mark_stable__',
                timeout=30,
            ),
        }

    # ── Internal helpers ───────────────────────────────────────────────

    def _known_good_path(self, comp_cfg: dict, project: Path) -> Path:
        return project / comp_cfg.get('known_good_file', '.claude/watch/known-good.json')

    def _load_known(self, comp_cfg: dict, project: Path) -> dict[str, str]:
        path = self._known_good_path(comp_cfg, project)
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data.get('repos', {})
        except Exception:
            return {}

    def _save_known(self, comp_cfg: dict, project: Path, commits: dict[str, str],
                    stable_checks: int = 0) -> None:
        path = self._known_good_path(comp_cfg, project)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'stable_checks': stable_checks,
            'repos': commits,
        }
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                       encoding='utf-8')

    def _current_heads(self, comp_cfg: dict, project: Path) -> dict[str, str]:
        heads: dict[str, str] = {}
        for repo in comp_cfg.get('repositories', []):
            repo_path = (project / repo['path']).resolve()
            try:
                h = subprocess.check_output(['git', 'rev-parse', 'HEAD'],
                                            cwd=repo_path, text=True, timeout=5).strip()
                heads[repo['name']] = h
            except Exception:
                pass
        return heads

    # ── Action handlers (called by core loop) ──────────────────────────

    def execute_action(self, action_name: str, comp_cfg: dict, global_cfg: dict,
                       project: Path, context: dict) -> bool:
        if action_name == 'deploy':
            return self._deploy(comp_cfg, global_cfg, project, context)
        elif action_name == 'rollback':
            return self._rollback(comp_cfg, global_cfg, project)
        elif action_name == 'mark_stable':
            return self._mark_stable(comp_cfg, project)
        return False

    def _deploy(self, comp_cfg: dict, global_cfg: dict, project: Path,
                context: dict) -> bool:
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
        known = self._load_known(comp_cfg, project)
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

            # Clean stale staging
            if staging.exists():
                _remove_worktree(staging, repo_path)

            print(f'[git_version]   [{name}] worktree at {staging} ({target[:8]})')
            try:
                subprocess.run(
                    ['git', 'worktree', 'add', '--detach', str(staging), target],
                    cwd=repo_path, check=True, capture_output=True, text=True, timeout=30,
                )
            except subprocess.CalledProcessError as e:
                print(f'[git_version]   [{name}] worktree FAILED: {e.stderr}')
                # Cleanup all worktrees created so far
                for n, d in staging_dirs.items():
                    _remove_worktree(d, (project / next(
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

            # Set env vars for cross-repo access
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
            _remove_worktree(staging, repo_path)

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
                self._rollback(comp_cfg, global_cfg, project)
                context['deploy_result'] = 'failed'
                context['deploy_failure_reason'] = f'Failed to update deploy branch for {name}'
                return False

        # Update known-good for ALL repos (including unchanged ones)
        self._save_known(comp_cfg, project, new_heads, stable_checks=0)
        context['deploy_result'] = 'passed'
        context['deploy_branch_updated'] = True
        print(f'[git_version] Deploy branch updated. Known-good saved (stable_checks=0).')

        # ── Phase 4: Test-port gate (optional) ──
        enable_test_gate = deploy_cfg.get('enable_test_gate', False)
        test_health_url = deploy_cfg.get('test_health_url', '')
        if not enable_test_gate or not test_health_url:
            print(f'[git_version] Test gate disabled — production restart delegated to SKILL.md.')
            return True

        # Start test instance on alternate port
        registry = context.get('_registry')
        test_start_action = deploy_cfg.get('test_start_action', '')
        if registry and test_start_action:
            start_act = registry.get_action(test_start_action) if hasattr(registry, 'get_action') else None
            if start_act:
                print(f'[git_version] Starting test instance via {test_start_action}...')
                from core.actions import _execute_action
                _execute_action(start_act, project, registry, '', context)
        time.sleep(deploy_cfg.get('test_prestart_sleep', 5))

        # Health-check the test instance
        print(f'[git_version] Health-checking test instance at {test_health_url}...')
        test_healthy = self._health_check_url(
            test_health_url,
            deploy_cfg.get('test_health_timeout', 30),
        )

        # Kill test instance
        test_kill_action = deploy_cfg.get('test_kill_action', '')
        if registry and test_kill_action:
            kill_act = registry.get_action(test_kill_action) if hasattr(registry, 'get_action') else None
            if kill_act:
                from core.actions import _execute_action
                _execute_action(kill_act, project, registry, '', context)

        if not test_healthy:
            print(f'[git_version] Test instance health check FAILED at {test_health_url}')
            self._rollback(comp_cfg, global_cfg, project)
            context['deploy_result'] = 'failed_test_health'
            context['deploy_failure_reason'] = (
                f'Test instance at {test_health_url} did not become healthy. '
                'Deploy branch reverted to known-good. Production service was NOT touched.'
            )
            return False

        print(f'[git_version] Test instance health check PASSED.')
        context['deploy_test_health_passed'] = True
        print(f'[git_version] Production restart delegated to SKILL.md.')
        return True

    def _rollback(self, comp_cfg: dict, global_cfg: dict, project: Path) -> bool:
        """Rollback all repos to known-good versions on deploy branch."""
        known = self._load_known(comp_cfg, project)
        if not known:
            print('[git_version] No known-good versions recorded.')
            return False

        deploy_cfg = comp_cfg.get('deploy', {})
        deploy_branch = deploy_cfg.get('deploy_branch', 'deploy')
        repos = comp_cfg.get('repositories', [])
        ok = True
        for repo in repos:
            name = repo['name']
            target = known.get(name)
            if not target:
                continue
            repo_path = (project / repo['path']).resolve()
            current = None
            try:
                current = subprocess.check_output(['git', 'rev-parse', 'HEAD'],
                                                  cwd=repo_path, text=True, timeout=5).strip()
            except Exception:
                pass
            if current == target:
                print(f'[git_version]   [{name}] already at {target[:8]}')
                continue
            print(f'[git_version] Rollback [{name}]: {current[:8] if current else "?"} -> {target[:8]}')
            try:
                subprocess.run(['git', 'checkout', '-f', deploy_branch],
                               cwd=repo_path, check=True, capture_output=True, timeout=10)
                subprocess.run(['git', 'reset', '--hard', target],
                               cwd=repo_path, check=True, capture_output=True, timeout=10)
                print(f'[git_version]   [{name}] OK')
            except subprocess.CalledProcessError as e:
                print(f'[git_version]   [{name}] FAILED: {e.stderr}')
                ok = False
        return ok

    def _mark_stable(self, comp_cfg: dict, project: Path) -> bool:
        """Mark current HEADs as known-good with incremented stable_checks."""
        commits = self._current_heads(comp_cfg, project)
        if not commits:
            return False

        # Preserve stable_checks if same commits
        known = self._load_known(comp_cfg, project)
        stable = 0
        if known == commits:
            path = self._known_good_path(comp_cfg, project)
            if path.exists():
                try:
                    old = json.loads(path.read_text(encoding='utf-8'))
                    stable = old.get('stable_checks', 0) + 1
                except Exception:
                    pass

        self._save_known(comp_cfg, project, commits, stable_checks=stable)
        print(f'[git_version] Known-good updated (stable_checks={stable})')
        return True

    @staticmethod
    def _health_check_url(url: str, timeout: int, interval: float = 2.0) -> bool:
        """Poll a health URL until 2xx response or timeout expires. Stdlib only."""
        import socket
        import urllib.error
        import urllib.request
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=min(5, timeout)) as resp:
                    if 200 <= resp.status < 300:
                        return True
            except (urllib.error.URLError, OSError, socket.timeout):
                pass
            time.sleep(interval)
        return False


def _remove_worktree(staging_path: Path, repo_path: Path) -> None:
    """Remove a git worktree, falling back to shutil.rmtree."""
    try:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(staging_path)],
                       cwd=repo_path, capture_output=True, timeout=10)
        subprocess.run(['git', 'worktree', 'prune'], cwd=repo_path,
                       capture_output=True, timeout=5)
    except Exception:
        shutil.rmtree(staging_path, ignore_errors=True)
