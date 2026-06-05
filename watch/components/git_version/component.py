"""Multi-repo version tracking component — known-good snapshots, worktree deploy gate."""

from __future__ import annotations

import json
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

        result.metrics['new_commits'] = total_new
        result.data['new_commits'] = total_new
        result.data['new_commits_detail'] = ', '.join(details) if details else 'none'
        state['_git_new_commits'] = total_new
        state['_git_detail'] = result.data['new_commits_detail']

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
                description='Worktree-based deploy: fetch → test → apply or reject',
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
        return project / comp_cfg.get('known_good_file', '.claude/known-good-versions.json')

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
        """Worktree-based deployment gate."""
        deploy_cfg = comp_cfg.get('deploy', {})
        staging = project / deploy_cfg.get('staging_dir', '.watch-staging')
        test_cmd = deploy_cfg.get('test_command', '')
        repos = comp_cfg.get('repositories', [])

        if not test_cmd or not repos:
            print('[git_version] No test_command or repositories configured.')
            return False

        # Get target commits (remote HEADs fetched in check())
        new_heads: dict[str, str] = {}
        primary_target: str | None = None
        for repo in repos:
            name = repo['name']
            branch = repo.get('branch', 'main')
            remote = repo.get('remote', 'origin')
            repo_path = (project / repo['path']).resolve()
            try:
                target = subprocess.check_output(
                    ['git', 'rev-parse', f'{remote}/{branch}'],
                    cwd=repo_path, text=True, timeout=5,
                ).strip()
                new_heads[name] = target
                if primary_target is None:
                    primary_target = target
            except Exception:
                continue

        if not new_heads:
            print('[git_version] No remote HEADs found.')
            return False

        # Clean stale staging
        primary_repo = (project / repos[0]['path']).resolve()
        primary_remote = repos[0].get('remote', 'origin')
        primary_branch = repos[0].get('branch', 'main')
        if staging.exists():
            try:
                subprocess.run(['git', 'worktree', 'remove', '--force', str(staging)],
                               cwd=primary_repo, capture_output=True, timeout=10)
                subprocess.run(['git', 'worktree', 'prune'], cwd=primary_repo,
                               capture_output=True, timeout=5)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)

        # Create worktree
        target_ref = primary_target or f'{primary_remote}/{primary_branch}'
        print(f'[git_version] Creating worktree at {staging} ({target_ref[:8]})')
        try:
            subprocess.run(
                ['git', 'worktree', 'add', '--detach', str(staging), target_ref],
                cwd=primary_repo, check=True, capture_output=True, text=True, timeout=30,
            )
        except subprocess.CalledProcessError as e:
            print(f'[git_version] Worktree creation failed: {e.stderr}')
            return False

        # Checkout sub-repos
        for repo in repos[1:]:
            name = repo['name']
            sub_path = staging / repo['path']
            target = new_heads.get(name)
            if not target or not sub_path.is_dir():
                continue
            try:
                subprocess.run(['git', '-C', str(sub_path), 'fetch', repo.get('remote', 'origin')],
                               check=True, capture_output=True, timeout=30)
                subprocess.run(['git', '-C', str(sub_path), 'checkout', '--detach', target],
                               check=True, capture_output=True, timeout=10)
                print(f'[git_version]   [{name}] → {target[:8]}')
            except subprocess.CalledProcessError as e:
                print(f'[git_version]   [{name}] FAILED: {e.stderr}')

        # Run tests
        print(f'[git_version] Running tests: {test_cmd}')
        t0 = time.time()
        try:
            r = subprocess.run(test_cmd, shell=True, cwd=staging, capture_output=True,
                               text=True, timeout=deploy_cfg.get('test_timeout', 300))
            elapsed = time.time() - t0
            tests_ok = r.returncode == 0
            print(f'[git_version] Tests {"PASSED" if tests_ok else "FAILED"} ({elapsed:.0f}s)')
            if not tests_ok and r.stdout:
                print(r.stdout[-1500:])
        except subprocess.TimeoutExpired:
            print(f'[git_version] Tests TIMED OUT')
            tests_ok = False

        # Cleanup worktree
        try:
            subprocess.run(['git', 'worktree', 'remove', '--force', str(staging)],
                           cwd=primary_repo, capture_output=True, timeout=10)
            subprocess.run(['git', 'worktree', 'prune'], cwd=primary_repo,
                           capture_output=True, timeout=5)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)

        if tests_ok:
            # Apply to main repos
            print('[git_version] Deploying to main repos...')
            for repo in repos:
                name = repo['name']
                branch = repo.get('branch', 'main')
                remote = repo.get('remote', 'origin')
                repo_path = (project / repo['path']).resolve()
                target = new_heads.get(name)
                if not target:
                    continue
                try:
                    subprocess.run(['git', 'checkout', branch], cwd=repo_path,
                                   check=True, capture_output=True, timeout=10)
                    subprocess.run(['git', 'merge', '--ff-only', f'{remote}/{branch}'],
                                   cwd=repo_path, check=True, capture_output=True, timeout=10)
                except subprocess.CalledProcessError:
                    subprocess.run(['git', 'reset', '--hard', target],
                                   cwd=repo_path, check=True, capture_output=True, timeout=10)
                print(f'[git_version]   [{name}] → {target[:8]}')

            self._save_known(comp_cfg, project, new_heads, stable_checks=0)
            context['deploy_result'] = 'passed'
            print('[git_version] Deploy complete. Known-good updated (stable_checks=0).')
            return True
        else:
            context['deploy_result'] = 'failed'
            context['deploy_failed_commits'] = str({k: v[:8] for k, v in new_heads.items()})
            print(f'[git_version] Deploy ABORTED — tests failed. Rejected: {context["deploy_failed_commits"]}')
            return False

    def _rollback(self, comp_cfg: dict, global_cfg: dict, project: Path) -> bool:
        """Rollback all repos to known-good versions."""
        known = self._load_known(comp_cfg, project)
        if not known:
            print('[git_version] No known-good versions recorded.')
            return False

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
            print(f'[git_version] Rollback [{name}]: {current[:8] if current else "?"} → {target[:8]}')
            try:
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
