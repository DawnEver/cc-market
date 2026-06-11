"""Multi-repo version tracking component — known-good snapshots, worktree deploy gate."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, CheckResult, Component, RemedyStep


# ── Module-level helpers (shared with deploy/backport modules) ──────────

def known_good_path(comp_cfg: dict, project: Path) -> Path:
    return project / comp_cfg.get('known_good_file', '.claude/watch/known-good.json')


def load_known(comp_cfg: dict, project: Path) -> dict[str, str]:
    path = known_good_path(comp_cfg, project)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        return data.get('repos', {})
    except Exception:
        return {}


def save_known(comp_cfg: dict, project: Path, commits: dict[str, str],
               stable_checks: int = 0) -> None:
    path = known_good_path(comp_cfg, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'stable_checks': stable_checks,
        'repos': commits,
    }
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8')


def current_heads(comp_cfg: dict, project: Path) -> dict[str, str]:
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


def health_check_url(url: str, timeout: int, interval: float = 2.0) -> bool:
    """Poll a health URL until 2xx response or timeout expires. Stdlib only."""
    import socket
    import time
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


def remove_worktree(staging_path: Path, repo_path: Path) -> None:
    """Remove a git worktree, falling back to shutil.rmtree."""
    try:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(staging_path)],
                       cwd=repo_path, capture_output=True, timeout=10)
        subprocess.run(['git', 'worktree', 'prune'], cwd=repo_path,
                       capture_output=True, timeout=5)
    except Exception:
        shutil.rmtree(staging_path, ignore_errors=True)


def rollback_repos(comp_cfg: dict, project: Path) -> bool:
    """Rollback all repos to known-good versions on deploy branch."""
    known = load_known(comp_cfg, project)
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


# ── Component class ────────────────────────────────────────────────────

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

        known = load_known(comp_cfg, project)

        kg_path = known_good_path(comp_cfg, project)
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
        deploy_branch = comp_cfg.get('deploy', {}).get('deploy_branch', 'deploy')
        total_deploy_ahead = 0
        deploy_ahead_details: list[str] = []

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

            # Detect hotfixes landed directly on deploy branch
            try:
                remote_deploy_head = subprocess.check_output(
                    ['git', 'rev-parse', f'{remote}/{deploy_branch}'],
                    cwd=repo_path, text=True, timeout=5,
                ).strip()
            except Exception:
                remote_deploy_head = None

            deploy_ahead = 0
            if remote_deploy_head and remote_deploy_head != remote_head:
                try:
                    deploy_ahead = int(subprocess.check_output(
                        ['git', 'rev-list', '--count', f'{remote_head}..{remote_deploy_head}'],
                        cwd=repo_path, text=True, timeout=5,
                    ).strip())
                except Exception:
                    deploy_ahead = 0

            result.metrics[f'{name}_deploy_ahead'] = deploy_ahead
            if deploy_ahead > 0:
                total_deploy_ahead += deploy_ahead
                deploy_ahead_details.append(f'{name}: +{deploy_ahead}')
                try:
                    log_out = subprocess.check_output(
                        ['git', 'log', '--oneline', f'{remote_head}..{remote_deploy_head}'],
                        cwd=repo_path, text=True, timeout=5,
                    ).strip()
                    result.data[f'{name}_deploy_ahead_pending'] = log_out.split('\n') if log_out else []
                except Exception:
                    result.data[f'{name}_deploy_ahead_pending'] = []

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
                count = 1

            if count > 0:
                total_new += count
                details.append(f'{name}: +{count}')
                result.data[f'{name}_new_head'] = remote_head
                if known_commit:
                    try:
                        log_out = subprocess.check_output(
                            ['git', 'log', '--oneline', f'{known_commit}..{remote_head}'],
                            cwd=repo_path, text=True, timeout=5,
                        ).strip()
                        result.data[f'{name}_pending'] = log_out.split('\n') if log_out else []
                    except Exception:
                        result.data[f'{name}_pending'] = []

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

        result.metrics['deploy_ahead_total'] = total_deploy_ahead
        result.data['deploy_ahead_detail'] = ', '.join(deploy_ahead_details) if deploy_ahead_details else 'none'
        if total_deploy_ahead > 0:
            result.anomalies.append(Anomaly(
                type='deploy_ahead_of_main', severity='warning',
                value=total_deploy_ahead,
                message=f'{deploy_branch} branch ahead of main: {result.data["deploy_ahead_detail"]}',
            ))

        return result

    def remedies(self) -> dict[str, list[RemedyStep]]:
        return {
            'new_version_available': [
                RemedyStep(action='deploy'),
            ],
            'deploy_ahead_of_main': [
                RemedyStep(action='backport_deploy'),
            ],
        }

    def actions(self) -> dict[str, Action]:
        return {
            'deploy': Action(
                description='Worktree-based deploy: fetch -> test -> apply or reject',
                command='__deploy__',
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
            'backport_deploy': Action(
                description='Merge deploy-branch hotfixes back into main: worktree merge -> test -> push',
                command='__backport__',
                timeout=600,
            ),
        }

    # ── Action handlers ──────────────────────────────────────────────

    def execute_action(self, action_name: str, comp_cfg: dict, global_cfg: dict,
                       project: Path, context: dict) -> bool:
        if action_name == 'deploy':
            return self._deploy(comp_cfg, global_cfg, project, context)
        elif action_name == 'rollback':
            return self._rollback(comp_cfg, global_cfg, project)
        elif action_name == 'mark_stable':
            return self._mark_stable(comp_cfg, project)
        elif action_name == 'backport_deploy':
            return self._backport(comp_cfg, global_cfg, project, context)
        return False

    def _deploy(self, comp_cfg: dict, _global_cfg: dict, project: Path,
                context: dict) -> bool:
        from components.git_version_deploy import deploy_repos
        return deploy_repos(comp_cfg, project, context)

    def _rollback(self, comp_cfg: dict, global_cfg: dict, project: Path) -> bool:
        return rollback_repos(comp_cfg, project)

    def _backport(self, comp_cfg: dict, global_cfg: dict, project: Path,
                  context: dict) -> bool:
        from components.git_version_backport import backport_deploy
        return backport_deploy(comp_cfg, project, context)

    def _mark_stable(self, comp_cfg: dict, project: Path) -> bool:
        """Mark current HEADs as known-good with incremented stable_checks."""
        commits = current_heads(comp_cfg, project)
        if not commits:
            return False

        known = load_known(comp_cfg, project)
        stable = 0
        if known == commits:
            path = known_good_path(comp_cfg, project)
            if path.exists():
                try:
                    old = json.loads(path.read_text(encoding='utf-8'))
                    stable = old.get('stable_checks', 0) + 1
                except Exception:
                    pass

        save_known(comp_cfg, project, commits, stable_checks=stable)
        print(f'[git_version] Known-good updated (stable_checks={stable})')
        return True
