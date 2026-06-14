"""One-way deploy gate — test new main commit in staging, then swap the deploy
worktree to it and restart production. No backport, no deploy-branch edits."""

from __future__ import annotations

import contextlib
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from core.log import append_report
from core.pidfile import pid_alive
from components.base import NO_WINDOW
from components.versioning.git_version import (
    changed_targets,
    clear_failures,
    deploy_path,
    deploy_signature,
    health_check_url,
    load_known,
    record_failure,
    remove_worktree,
    rollback_repos,
    save_known,
)


def _nest_map(repos: list[dict]) -> dict[str, list[dict]]:
    """host repo name → list of repos that must be nested inside its worktree."""
    nests: dict[str, list[dict]] = {}
    for r in repos:
        host = r.get('nest_into')
        if host:
            nests.setdefault(host, []).append(r)
    return nests


def _all_healthy(urls: list[str], timeout: int) -> bool:
    return all(health_check_url(u, timeout) for u in urls) if urls else True


def _run_restart(comp_cfg: dict, project: Path, context: dict,
                 action_key: str = 'production_restart_action') -> None:
    """Execute a configured restart action. `action_key` selects which one:
    the deploy chain uses `production_restart_action` (rebuilds the frontend, since
    new code shipped); the recovery ladder uses `recover_restart_action` (preview
    only, no rebuild — the dist/ is already built) and falls back to the deploy one."""
    registry = context.get('_registry')
    deploy_cfg = comp_cfg.get('deploy', {})
    action_name = deploy_cfg.get(action_key) or deploy_cfg.get('production_restart_action', '')
    if not (registry and action_name and hasattr(registry, 'get_action')):
        return
    act = registry.get_action(action_name)
    if not act:
        return
    from core.actions import _execute_action
    print(f'[git_version] Restarting production via {action_name}...')
    _execute_action(act, project, registry, '', context)


_DEPLOY_LOCK = '.claude/watch/state/deploy.lock'
_DEPLOY_AUDIT = '.claude/watch/logs/deploy.jsonl'


_DEPLOY_THREAD_LOCK = threading.Lock()


@contextlib.contextmanager
def _deploy_lock(project: Path):
    """Single 'deploy-in-progress' guard. Yields True if we hold it, False if a
    deploy already runs (caller must bail without touching staging). Serializes both
    across threads (an in-process ``threading.Lock``) and across processes (an
    ``O_EXCL`` lockfile whose live owner — same or other PID — blocks). A stale lock
    whose owner PID is dead is taken over (reuses pidfile.pid_alive)."""
    lock = project / _DEPLOY_LOCK
    lock.parent.mkdir(parents=True, exist_ok=True)
    # In-process guard: a second deploy on another thread must see us as busy.
    if not _DEPLOY_THREAD_LOCK.acquire(blocking=False):
        yield False
        return
    held = False
    try:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            owner = None
            with contextlib.suppress(ValueError, OSError):
                owner = int(lock.read_text(encoding='ascii').strip())
            # A live owner (this PID or another) means a deploy is in progress.
            if owner is not None and pid_alive(owner):
                yield False
                return
            # Stale (dead owner / unreadable) — take it over.
            with contextlib.suppress(OSError):
                lock.unlink()
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode('ascii'))
        os.close(fd)
        held = True
        yield True
    finally:
        if held:
            with contextlib.suppress(OSError):
                lock.unlink()
        _DEPLOY_THREAD_LOCK.release()


def _audit(project: Path, **fields) -> None:
    """Append one structured per-deploy event to deploy.jsonl (best-effort)."""
    event = {'ts': datetime.now(timezone.utc).isoformat(), **fields}
    with contextlib.suppress(Exception):
        append_report(event, project, log_file=_DEPLOY_AUDIT, max_entries=10000)


def deploy_repos(comp_cfg: dict, project: Path, context: dict) -> bool:
    """Test changed main commits in staging worktrees, then swap deploy
    worktrees and restart production. Records a distinct failure signature on
    any gate failure (production is never left broken). Serialized by a single
    deploy-in-progress lock so a second concurrent deploy bails cleanly."""
    with _deploy_lock(project) as acquired:
        if not acquired:
            print('[git_version] Another deploy is in progress — skipping.')
            _audit(project, phase='lock', outcome='skipped',
                   reason='another deploy in progress')
            return False
        return _deploy_repos_locked(comp_cfg, project, context)


def _deploy_repos_locked(comp_cfg: dict, project: Path, context: dict) -> bool:
    deploy_cfg = comp_cfg.get('deploy', {})
    repos = comp_cfg.get('repositories', [])
    test_cmd = deploy_cfg.get('test_command', '')
    staging_base = project / deploy_cfg.get('staging_dir', '.watch-staging')
    t_start = time.time()
    if not repos:
        print('[git_version] No repositories configured.')
        return False

    targets, changed, _ = changed_targets(comp_cfg, project, fetch=True)
    known = load_known(comp_cfg, project)
    repos_to_deploy = [r for r in repos if r['name'] in changed]
    if not repos_to_deploy:
        print('[git_version] All repos already at known-good. Nothing to deploy.')
        return True
    sig = deploy_signature(changed)
    nests = _nest_map(repos)
    print(f'[git_version] Deploying {len(repos_to_deploy)} repo(s): '
          f'{", ".join(r["name"] for r in repos_to_deploy)}')
    _audit(project, phase='start', outcome='running', commits=dict(changed),
           repos=[r['name'] for r in repos_to_deploy])

    def _fail(reason: str, phase: str = 'unknown', rollback_reason: str = '') -> bool:
        sigs = record_failure(comp_cfg, project, sig)
        context['deploy_result'] = 'failed'
        context['deploy_failure_reason'] = reason
        print(f'[git_version] Deploy ABORTED — {reason} '
              f'({len(sigs)} distinct failed commit(s)).')
        _audit(project, phase=phase, outcome='failed', error=reason,
               rollback_reason=rollback_reason, commits=dict(changed),
               failed_commit_count=len(sigs),
               duration_s=round(time.time() - t_start, 1))
        return False

    # ── Phase 1: staging worktrees (+ nested dependencies) ──
    staging_dirs: dict[str, Path] = {}
    nested_paths: list[tuple[Path, Path]] = []  # (nest_worktree, owning_repo_main_tree)

    def _cleanup() -> None:
        for npath, nmain in nested_paths:
            remove_worktree(npath, nmain)
        for nm, st in staging_dirs.items():
            main_tree = (project / next(
                r['path'] for r in repos_to_deploy if r['name'] == nm)).resolve()
            remove_worktree(st, main_tree)

    for repo in repos_to_deploy:
        name = repo['name']
        main_tree = (project / repo['path']).resolve()
        staging = staging_base / name
        if staging.exists():
            remove_worktree(staging, main_tree)
        try:
            subprocess.run(['git', 'worktree', 'add', '--detach', str(staging), changed[name]],
                           cwd=main_tree, check=True, capture_output=True, text=True, timeout=30,
                           creationflags=NO_WINDOW)
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] worktree FAILED: {e.stderr}')
            _cleanup()
            return _fail(f'staging worktree creation failed for {name}', phase='staging')
        staging_dirs[name] = staging
        print(f'[git_version]   [{name}] staging {staging} ({changed[name][:8]})')

        # Nest dependencies (e.g. lib at usr/lib) so the host's tests can import them.
        for dep in nests.get(name, []):
            dep_main = (project / dep['path']).resolve()
            rel = os.path.relpath(dep_main, main_tree)
            dep_target = changed.get(dep['name']) or known.get(dep['name'])
            nest_at = staging / rel
            if not dep_target:
                print(f'[git_version]   [{name}] nest {dep["name"]}: no target, skip')
                continue
            if nest_at.exists():
                remove_worktree(nest_at, dep_main)
            try:
                subprocess.run(['git', 'worktree', 'add', '--detach', str(nest_at), dep_target],
                               cwd=dep_main, check=True, capture_output=True, text=True, timeout=30,
                               creationflags=NO_WINDOW)
                nested_paths.append((nest_at, dep_main))
                print(f'[git_version]   [{name}] nested {dep["name"]} at {rel} ({dep_target[:8]})')
            except subprocess.CalledProcessError as e:
                print(f'[git_version]   [{name}] nest FAILED: {e.stderr}')
                _cleanup()
                return _fail(f'nesting {dep["name"]} into {name} failed', phase='staging')

    # ── Phase 2: unit tests in staging ──
    test_env = os.environ.copy()
    test_env['WATCH_PROJECT_ROOT'] = str(project)
    tests_ok = True
    for repo in repos_to_deploy:
        name = repo['name']
        staging = staging_dirs[name]
        repo_test_cmd = repo.get('test_command', test_cmd)
        if not repo_test_cmd:
            continue
        test_env['WATCH_STAGING'] = str(staging)
        test_env['WATCH_STAGING_' + name.upper().replace('-', '_').replace(' ', '_')] = str(staging)
        print(f'[git_version]   [{name}] test: {repo_test_cmd}')
        t0 = time.time()
        try:
            r = subprocess.run(repo_test_cmd, shell=True, cwd=staging,
                               capture_output=True, text=True,
                               timeout=deploy_cfg.get('test_timeout', 300), env=test_env,
                               creationflags=NO_WINDOW)
            elapsed = time.time() - t0
            if r.returncode != 0:
                tests_ok = False
                print(f'[git_version]   [{name}] Tests FAILED ({elapsed:.0f}s)')
                if r.stdout:
                    print(r.stdout[-1500:])
                if r.stderr:
                    print(r.stderr[-1500:])
                break
            print(f'[git_version]   [{name}] Tests PASSED ({elapsed:.0f}s)')
        except subprocess.TimeoutExpired:
            print(f'[git_version]   [{name}] Tests TIMED OUT')
            tests_ok = False
            break

    # ── Phase 3: optional port health gate (test instance from staging) ──
    gate_ok = True
    if tests_ok and deploy_cfg.get('enable_test_gate', False):
        # Expose primary staging dir so the start action can launch staging code.
        primary = repos_to_deploy[0]
        os.environ['WATCH_STAGING'] = str(staging_dirs[primary['name']])
        gate_ok = _port_gate(deploy_cfg, project, context)

    _cleanup()

    if not tests_ok:
        return _fail('unit tests failed in staging — production untouched', phase='test')
    if not gate_ok:
        return _fail('port health gate failed in staging — production untouched',
                     phase='test_gate')
    _audit(project, phase='gate', outcome='passed', commits=dict(changed),
           duration_s=round(time.time() - t_start, 1))

    # ── Phase 4: swap deploy worktrees to the tested commits ──
    print('[git_version] Applying tested commits to deploy worktrees...')
    for repo in repos_to_deploy:
        name = repo['name']
        dpath = deploy_path(repo, project)
        target = changed[name]
        if not dpath.is_dir():
            return _fail(f'deploy_path missing for {name}: {dpath}', phase='apply')
        try:
            subprocess.run(['git', 'reset', '--hard', target],
                           cwd=dpath, check=True, capture_output=True, text=True, timeout=15,
                           creationflags=NO_WINDOW)
            print(f'[git_version]   [{name}] deploy worktree -> {target[:8]}')
        except subprocess.CalledProcessError as e:
            print(f'[git_version]   [{name}] apply FAILED: {e.stderr}')
            rollback_repos(comp_cfg, project)
            return _fail(f'failed to update deploy worktree for {name}', phase='apply',
                         rollback_reason='deploy worktree update failed mid-apply')

    # ── Phase 5: restart production and verify health ──
    prod_urls = deploy_cfg.get('production_health_url', [])
    if isinstance(prod_urls, str):
        prod_urls = [prod_urls]
    if comp_cfg.get('deploy', {}).get('production_restart_action'):
        _run_restart(comp_cfg, project, context)
        time.sleep(deploy_cfg.get('test_prestart_sleep', 5))
        if not _all_healthy(prod_urls, deploy_cfg.get('test_health_timeout', 30)):
            print('[git_version] Production unhealthy after deploy — rolling back.')
            rollback_repos(comp_cfg, project)
            _run_restart(comp_cfg, project, context)
            return _fail('production failed health check after deploy — rolled back',
                         phase='health',
                         rollback_reason='production unhealthy after deploy')

    save_known(comp_cfg, project, targets)
    clear_failures(comp_cfg, project)
    context['deploy_result'] = 'passed'
    context['deploy_branch_updated'] = True
    print('[git_version] Deploy complete. Known-good updated; failure counter cleared.')
    _audit(project, phase='complete', outcome='passed', commits=dict(changed),
           duration_s=round(time.time() - t_start, 1))
    return True


def _port_gate(deploy_cfg: dict, project: Path, context: dict) -> bool:
    """Start a test instance, health-check it, kill it. Returns True if healthy."""
    raw_url = deploy_cfg.get('test_health_url', '')
    if not raw_url:
        return True
    if isinstance(raw_url, str):
        raw_url = [raw_url]
    raw_start = deploy_cfg.get('test_start_action', '')
    raw_kill = deploy_cfg.get('test_kill_action', '')
    if isinstance(raw_start, str):
        raw_start = [raw_start] * len(raw_url)
    if isinstance(raw_kill, str):
        raw_kill = [raw_kill] * len(raw_url)

    registry = context.get('_registry')
    prestart = deploy_cfg.get('test_prestart_sleep', 5)
    htimeout = deploy_cfg.get('test_health_timeout', 30)
    from core.actions import _execute_action

    for i, url in enumerate(raw_url):
        start_action = raw_start[i] if i < len(raw_start) else ''
        kill_action = raw_kill[i] if i < len(raw_kill) else ''
        if registry and start_action:
            act = registry.get_action(start_action)
            if act:
                print(f'[git_version] Starting test instance via {start_action}...')
                _execute_action(act, project, registry, '', context)
        time.sleep(prestart)
        print(f'[git_version] Health-checking test instance at {url}...')
        healthy = health_check_url(url, htimeout)
        if registry and kill_action:
            act = registry.get_action(kill_action)
            if act:
                _execute_action(act, project, registry, '', context)
        if not healthy:
            print(f'[git_version] Test instance health check FAILED at {url}')
            return False
        print(f'[git_version] Test gate PASSED: {url}')
    return True


def recover_service(comp_cfg: dict, project: Path, context: dict) -> bool:
    """Production health recovery ladder: restart up to `restart_attempts` times;
    if still unhealthy, roll the deploy worktrees back to known-good and restart
    once more. Returns False (→ escalate) only if known-good itself won't run."""
    deploy_cfg = comp_cfg.get('deploy', {})
    prod_urls = deploy_cfg.get('production_health_url', [])
    if isinstance(prod_urls, str):
        prod_urls = [prod_urls]
    attempts = deploy_cfg.get('restart_attempts', 2)
    htimeout = deploy_cfg.get('test_health_timeout', 30)
    # Recovery restarts are preview-only (no rebuild), so they come up in seconds —
    # don't inherit the deploy gate's long staging sleep.
    prestart = deploy_cfg.get('recover_prestart_sleep', 5)

    for i in range(attempts):
        print(f'[git_version] Recovery restart attempt {i + 1}/{attempts}...')
        _run_restart(comp_cfg, project, context, 'recover_restart_action')
        time.sleep(prestart)
        if _all_healthy(prod_urls, htimeout):
            context['recovered'] = f'restart#{i + 1}'
            print('[git_version] Production healthy after restart.')
            return True

    print('[git_version] Restarts exhausted — rolling back to known-good.')
    rollback_repos(comp_cfg, project)
    _run_restart(comp_cfg, project, context, 'recover_restart_action')
    time.sleep(prestart)
    if _all_healthy(prod_urls, htimeout):
        context['recovered'] = 'rollback'
        print('[git_version] Production healthy after rollback to known-good.')
        return True

    context['deploy_failure_reason'] = (
        f'Production still unhealthy after {attempts} restart(s) and a rollback to '
        f'known-good — the known-good version itself is not serving.')
    print('[git_version] Recovery FAILED — known-good not serving. Escalating.')
    return False
