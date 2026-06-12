"""Multi-repo version tracking — one-way deploy: main → known-good → deploy worktree.

Strict model: all development/testing happens on the `main` branch (the watchd
working tree). A new main commit is tested in an isolated staging worktree; on
pass it becomes known-good and is pushed into a dedicated *deploy worktree*
(`deploy_path`) that runs production. The deploy branch is never edited by hand —
on any production problem it is reset back to known-good. No backport, no hotfix.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, CheckResult, Component, RemedyStep


# ── Known-good snapshot ─────────────────────────────────────────────────

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


def save_known(comp_cfg: dict, project: Path, commits: dict[str, str]) -> None:
    path = known_good_path(comp_cfg, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'repos': commits,
    }
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8')


# ── Failed-commit tracking (escalate after N distinct failed deploys) ───

def failures_path(comp_cfg: dict, project: Path) -> Path:
    return project / comp_cfg.get('deploy_failures_file',
                                  '.claude/watch/state/deploy_failures.json')


def load_failures(comp_cfg: dict, project: Path) -> list[str]:
    path = failures_path(comp_cfg, project)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding='utf-8')).get('signatures', [])
    except Exception:
        return []


def record_failure(comp_cfg: dict, project: Path, signature: str) -> list[str]:
    """Append a distinct failed-deploy signature; return the full list."""
    sigs = load_failures(comp_cfg, project)
    if signature and signature not in sigs:
        sigs.append(signature)
    path = failures_path(comp_cfg, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'signatures': sigs,
    }, ensure_ascii=False) + '\n', encoding='utf-8')
    return sigs


def clear_failures(comp_cfg: dict, project: Path) -> None:
    path = failures_path(comp_cfg, project)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass


def deploy_signature(changed_heads: dict[str, str]) -> str:
    """Stable signature of a would-be deploy (the set of target commits)."""
    return json.dumps(sorted(changed_heads.items()))


# ── Worktree / path helpers ─────────────────────────────────────────────

def deploy_path(repo: dict, project: Path) -> Path:
    """The production (deploy) worktree for a repo. Falls back to `path`."""
    return (project / repo.get('deploy_path', repo['path'])).resolve()


def current_heads(comp_cfg: dict, project: Path) -> dict[str, str]:
    """HEAD of each repo's main working tree (`path`)."""
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


def remote_heads(comp_cfg: dict, project: Path,
                 fetch: bool = True) -> tuple[dict[str, str], list[str]]:
    """Remote tracking HEAD (`<remote>/<branch>`) of each repo, optionally fetching.

    Returns (heads, fetch_failed) where fetch_failed lists repos whose `git fetch`
    did not succeed after retries. This matters because on fetch failure the stale
    local remote-tracking ref still resolves — silently masking new upstream commits
    as "no change". Callers escalate persistent fetch_failed so the blindness is loud.
    """
    heads: dict[str, str] = {}
    fetch_failed: list[str] = []
    for repo in comp_cfg.get('repositories', []):
        repo_path = (project / repo['path']).resolve()
        if not repo_path.is_dir():
            continue
        remote = repo.get('remote', 'origin')
        branch = repo.get('branch', 'main')
        if fetch:
            # git fetch against this remote is flaky (auth/network) and often
            # only succeeds on a later attempt — retry a few times.
            ok = False
            for attempt in range(3):
                r = subprocess.run(['git', 'fetch', remote], cwd=repo_path,
                                   capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    ok = True
                    break
                if attempt == 2:
                    print(f'[git_version] fetch {remote} failed for {repo["name"]} '
                          f'after 3 attempts: {r.stderr.strip()[:200]}')
            if not ok:
                fetch_failed.append(repo['name'])
        try:
            heads[repo['name']] = subprocess.check_output(
                ['git', 'rev-parse', f'{remote}/{branch}'],
                cwd=repo_path, text=True, timeout=5).strip()
        except Exception:
            pass
    return heads, fetch_failed


def changed_targets(comp_cfg: dict, project: Path, fetch: bool = True
                    ) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """Return (all_targets, changed, fetch_failed) where `changed` is the subset of
    repos whose remote main head differs from known-good, and `fetch_failed` lists
    repos whose fetch did not succeed (their head may be stale → not trustworthy)."""
    known = load_known(comp_cfg, project)
    targets, fetch_failed = remote_heads(comp_cfg, project, fetch=fetch)
    changed = {n: h for n, h in targets.items() if known.get(n) != h}
    return targets, changed, fetch_failed


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
    """Reset every deploy worktree (`deploy_path`) back to known-good. The deploy
    branch is force-reset; main working trees are never touched."""
    known = load_known(comp_cfg, project)
    if not known:
        print('[git_version] No known-good versions recorded.')
        return False

    ok = True
    for repo in comp_cfg.get('repositories', []):
        name = repo['name']
        target = known.get(name)
        if not target:
            continue
        dpath = deploy_path(repo, project)
        if not dpath.is_dir():
            print(f'[git_version]   [{name}] deploy_path missing: {dpath}')
            ok = False
            continue
        try:
            current = subprocess.check_output(['git', 'rev-parse', 'HEAD'],
                                              cwd=dpath, text=True, timeout=5).strip()
        except Exception:
            current = None
        if current == target:
            print(f'[git_version]   [{name}] already at {target[:8]}')
            continue
        print(f'[git_version] Rollback [{name}]: {current[:8] if current else "?"} -> {target[:8]}')
        try:
            subprocess.run(['git', 'reset', '--hard', target],
                           cwd=dpath, check=True, capture_output=True, timeout=10)
            print(f'[git_version]   [{name}] OK')
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] FAILED: {e.stderr}')
            ok = False
    return ok


# ── Component class ────────────────────────────────────────────────────

class GitVersion(Component):
    name = 'git_version'
    description = 'One-way deploy — main tested → known-good → deploy worktree; rollback only'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        repos = comp_cfg.get('repositories', [])
        project = Path(global_cfg.get('_project_dir', '.'))
        result = CheckResult()
        if not repos:
            return result

        kg_path = known_good_path(comp_cfg, project)
        if kg_path.exists():
            try:
                result.data['last_updated'] = json.loads(
                    kg_path.read_text(encoding='utf-8')).get('updated_at')
            except Exception:
                pass

        targets, changed, fetch_failed = changed_targets(comp_cfg, project, fetch=True)
        for name, head in targets.items():
            result.metrics[f'{name}_changed'] = int(name in changed)
            if name in changed:
                result.data[f'{name}_target'] = head

        # Fetch blindness — a failed `git fetch` leaves a stale remote-tracking ref,
        # so new upstream commits look like "no change" (changed=={}). Distinguish it
        # from a genuine no-op: count a streak and escalate only after a few rounds so
        # a single transient flake doesn't false-alarm.
        deploy_cfg = comp_cfg.get('deploy', {})
        if fetch_failed:
            streak = state.get('_fetch_fail_streak', 0) + 1
            state['_fetch_fail_streak'] = streak
            result.metrics['fetch_fail_streak'] = streak
            escalate_after = deploy_cfg.get('fetch_fail_escalate_after', 3)
            if streak >= escalate_after:
                result.anomalies.append(Anomaly(
                    type='fetch_unreachable', severity='critical',
                    value=streak, threshold=escalate_after,
                    message=(f'git fetch failed {streak} poll(s) in a row for '
                             f'{", ".join(fetch_failed)} — watchd cannot see new '
                             f'commits, deploy detection is blind'),
                ))
        else:
            state.pop('_fetch_fail_streak', None)

        sig = deploy_signature(changed)
        failures = load_failures(comp_cfg, project)
        max_failed = comp_cfg.get('deploy', {}).get('max_failed_commits', 3)

        detail = ', '.join(f'{n}: {h[:8]}' for n, h in changed.items()) or 'none'
        result.metrics['new_commits'] = len(changed)
        result.data['new_commits_detail'] = detail
        result.metrics['failed_commits'] = len(failures)

        # New deployable version — but suppress if this exact target already
        # failed its gate (await a fresh fix commit instead of retry-spinning).
        if changed and sig not in failures:
            result.anomalies.append(Anomaly(
                type='new_version_available', severity='warning',
                value=len(changed),
                message=f'New tested-on-main version pending deploy: {detail}',
            ))

        # Distinct failed commits piled up → escalate to a human.
        if len(failures) >= max_failed:
            result.anomalies.append(Anomaly(
                type='deploy_failed', severity='critical',
                value=len(failures), threshold=max_failed,
                message=(f'{len(failures)} distinct main commits failed the deploy '
                         f'gate — fix on main is not converging; manual attention needed'),
            ))
        return result

    def remedies(self) -> dict[str, list[RemedyStep]]:
        return {
            'new_version_available': [RemedyStep(action='deploy')],
            'deploy_failed': [RemedyStep(action='notify', escalate_after=1)],
            'fetch_unreachable': [RemedyStep(action='notify', escalate_after=1)],
        }

    def actions(self) -> dict[str, Action]:
        return {
            'deploy': Action(
                description='Test new main commit in staging; on pass swap deploy '
                            'worktree + restart production; rollback/record on fail',
                command='__deploy__', timeout=900,
            ),
            'rollback': Action(
                description='Reset deploy worktrees to known-good',
                command='__rollback__', timeout=120,
            ),
            'recover_service': Action(
                description='Restart production up to N times, else rollback to '
                            'known-good and restart; escalate if still unhealthy',
                command='__recover_service__', timeout=300,
            ),
            'notify': Action(
                description='No-op whose failure-escalation sends the alert',
                command='exit 0', shell=True, timeout=10,
            ),
        }

    # ── Action handlers ──────────────────────────────────────────────

    def execute_action(self, action_name: str, comp_cfg: dict, global_cfg: dict,
                       project: Path, context: dict) -> bool:
        if action_name == 'deploy':
            from components.git_version_deploy import deploy_repos
            return deploy_repos(comp_cfg, project, context)
        if action_name == 'rollback':
            return rollback_repos(comp_cfg, project)
        if action_name == 'recover_service':
            from components.git_version_deploy import recover_service
            return recover_service(comp_cfg, project, context)
        if action_name == 'notify':
            return True
        return False
