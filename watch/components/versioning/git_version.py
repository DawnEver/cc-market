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
import time
from datetime import datetime, timezone
from pathlib import Path

from components.base import NO_WINDOW, Action, Anomaly, CheckResult, Component, RemedyStep
from core.state import atomic_write_text, file_lock


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
    data = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'repos': commits,
    }
    with file_lock(path):
        atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + '\n')


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
    path = failures_path(comp_cfg, project)
    with file_lock(path):
        # Re-read inside the lock so concurrent appends can't clobber each other.
        sigs = load_failures(comp_cfg, project)
        if signature and signature not in sigs:
            sigs.append(signature)
        atomic_write_text(path, json.dumps({
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'signatures': sigs,
        }, ensure_ascii=False) + '\n')
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
                                        cwd=repo_path, text=True, timeout=5,
                                        creationflags=NO_WINDOW).strip()
            heads[repo['name']] = h
        except Exception:
            pass
    return heads


def classify_fetch_error(stderr: str) -> str:
    """Bucket a `git fetch` failure into a structured reason from its stderr.

    Returns one of: 'auth', 'network', 'corrupt', 'unknown'. Used to tell a human
    triaging a fetch_unreachable escalation *which* failure mode they're facing.
    """
    s = (stderr or '').lower()
    auth = ('authentication failed', 'could not read username', 'permission denied',
            'access denied', 'invalid username or password', 'remote: forbidden',
            '403 forbidden', '401 unauthorized', 'publickey')
    network = ('could not resolve host', 'connection timed out', 'connection refused',
               'connection reset', 'operation timed out', 'network is unreachable',
               'failed to connect', 'temporary failure in name resolution',
               'timed out', 'no route to host', 'unable to access')
    corrupt = ('not a git repository', 'does not appear to be a git repository',
               'bad object', 'object file', 'loose object', 'corrupt',
               'repository not found', 'fatal: could not read from remote repository')
    for needle in auth:
        if needle in s:
            return 'auth'
    for needle in network:
        if needle in s:
            return 'network'
    for needle in corrupt:
        if needle in s:
            return 'corrupt'
    return 'unknown'


def remote_heads(comp_cfg: dict, project: Path,
                 fetch: bool = True) -> tuple[dict[str, str], list[str]]:
    """Remote tracking HEAD (`<remote>/<branch>`) of each repo, optionally fetching.

    Returns (heads, fetch_failed) where fetch_failed lists repos whose `git fetch`
    did not succeed after retries. This matters because on fetch failure the stale
    local remote-tracking ref still resolves — silently masking new upstream commits
    as "no change". Callers escalate persistent fetch_failed so the blindness is loud.

    Each fetch_failed entry is formatted ``"<repo> (<reason>)"`` where reason is the
    classified failure mode (auth/network/corrupt/unknown), so the escalation message
    can say *which* failure occurred.
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
            last_stderr = ''
            for attempt in range(3):
                try:
                    r = subprocess.run(['git', 'fetch', remote], cwd=repo_path,
                                       capture_output=True, text=True, timeout=30,
                                       creationflags=NO_WINDOW)
                except subprocess.TimeoutExpired:
                    last_stderr = 'operation timed out'
                    continue
                if r.returncode == 0:
                    ok = True
                    break
                last_stderr = r.stderr.strip()
                if attempt == 2:
                    print(f'[git_version] fetch {remote} failed for {repo["name"]} '
                          f'after 3 attempts: {last_stderr[:200]}')
            if not ok:
                reason = classify_fetch_error(last_stderr)
                fetch_failed.append(f'{repo["name"]} ({reason})')
        try:
            heads[repo['name']] = subprocess.check_output(
                ['git', 'rev-parse', f'{remote}/{branch}'],
                cwd=repo_path, text=True, timeout=5,
                creationflags=NO_WINDOW).strip()
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


def remove_worktree(staging_path: Path, repo_path: Path, retries: int = 4) -> None:
    """Idempotently remove a git worktree; never raise on an already-gone tree.

    On Windows, freshly-used worktrees keep file handles (test runners, the OS
    indexer) that release slowly, so `git worktree remove --force` can transiently
    fail — retry with short exponential backoff before falling back to rmtree."""
    if not staging_path.exists():
        # Already removed — still prune any dangling registration, best-effort.
        try:
            subprocess.run(['git', 'worktree', 'prune'], cwd=repo_path,
                           capture_output=True, timeout=5, creationflags=NO_WINDOW)
        except Exception:
            pass
        return

    delay = 0.2
    for attempt in range(retries):
        try:
            r = subprocess.run(
                ['git', 'worktree', 'remove', '--force', str(staging_path)],
                cwd=repo_path, capture_output=True, text=True, timeout=10,
                creationflags=NO_WINDOW)
            if r.returncode == 0 or not staging_path.exists():
                break
        except subprocess.TimeoutExpired:
            pass
        if attempt < retries - 1:
            time.sleep(delay)
            delay = min(delay * 2, 1.5)

    try:
        subprocess.run(['git', 'worktree', 'prune'], cwd=repo_path,
                       capture_output=True, timeout=5, creationflags=NO_WINDOW)
    except Exception:
        pass
    # Last resort: physically drop the directory if git couldn't.
    if staging_path.exists():
        shutil.rmtree(staging_path, ignore_errors=True)


def deploy_drift(comp_cfg: dict, project: Path) -> list[tuple[str, str]]:
    """Audit every deploy worktree for read-only violations.

    The deploy worktree is plumbing: watchd resets it to known-good, nobody edits
    it by hand. Two violations are caught so a human is told *before* the next
    deploy/rollback silently `git reset --hard`s the work away:

      * dirty   — uncommitted changes in the working tree
      * diverged — HEAD carries commit(s) not reachable from the tracked remote
                   branch (someone committed directly on the deploy branch)

    Returns a list of ``(repo_name, reason)``. Only repos with an explicit,
    distinct ``deploy_path`` are checked (the main working tree is never read-only).
    All checks are plain git subprocess calls — identical on every platform.
    """
    drift: list[tuple[str, str]] = []
    for repo in comp_cfg.get('repositories', []):
        if not repo.get('deploy_path'):
            continue
        dpath = deploy_path(repo, project)
        main_tree = (project / repo['path']).resolve()
        if not dpath.is_dir() or dpath == main_tree:
            continue
        try:
            dirty = subprocess.check_output(
                ['git', 'status', '--porcelain'],
                cwd=dpath, text=True, timeout=10,
                creationflags=NO_WINDOW).strip()
        except Exception:
            continue
        if dirty:
            n = len(dirty.splitlines())
            drift.append((repo['name'], f'{n} uncommitted change(s) in deploy worktree'))
        # Diverged: deploy HEAD has commits not on the tracked remote branch.
        remote = repo.get('remote', 'origin')
        branch = repo.get('branch', 'main')
        try:
            ahead = subprocess.check_output(
                ['git', 'rev-list', '--count', f'{remote}/{branch}..HEAD'],
                cwd=dpath, text=True, timeout=10,
                creationflags=NO_WINDOW).strip()
            if ahead.isdigit() and int(ahead) > 0:
                drift.append((repo['name'],
                              f'{ahead} commit(s) on deploy not reachable from '
                              f'{remote}/{branch} — committed directly on deploy'))
        except Exception:
            pass
    return drift


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
                                              cwd=dpath, text=True, timeout=5,
                                              creationflags=NO_WINDOW).strip()
        except Exception:
            current = None
        if current == target:
            print(f'[git_version]   [{name}] already at {target[:8]}')
            continue
        print(f'[git_version] Rollback [{name}]: {current[:8] if current else "?"} -> {target[:8]}')
        try:
            subprocess.run(['git', 'reset', '--hard', target],
                           cwd=dpath, check=True, capture_output=True, timeout=10,
                           creationflags=NO_WINDOW)
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

        # Read-only enforcement — the deploy worktree must mirror known-good, never
        # be edited or committed to directly. Surface drift before the next
        # deploy/rollback reset --hard destroys it.
        drift = deploy_drift(comp_cfg, project)
        result.metrics['deploy_drift'] = len(drift)
        if drift:
            detail_drift = '; '.join(f'{n}: {why}' for n, why in drift)
            result.anomalies.append(Anomaly(
                type='deploy_worktree_dirty', severity='warning',
                value=len(drift),
                message=(f'Deploy worktree is not read-only — {detail_drift}. '
                         f'watchd manages it via reset-to-known-good; commit on '
                         f'main instead (these changes will be lost on next deploy).'),
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
            # Drift is a human mistake (don't auto-destroy their uncommitted work) —
            # alert after a couple of polls so a transient mid-edit doesn't spam.
            'deploy_worktree_dirty': [RemedyStep(action='notify', escalate_after=2)],
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
            from components.versioning.git_version_deploy import deploy_repos
            return deploy_repos(comp_cfg, project, context)
        if action_name == 'rollback':
            return rollback_repos(comp_cfg, project)
        if action_name == 'recover_service':
            from components.versioning.git_version_deploy import recover_service
            return recover_service(comp_cfg, project, context)
        if action_name == 'notify':
            return True
        return False
