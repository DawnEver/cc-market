"""Component interface — every health check is a Component."""

from __future__ import annotations

import json
import subprocess
import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_ACTIVE_RUN_FILE = '.claude/watch/active-run.json'

# On Windows, a subprocess.run/Popen/check_output started without this flag
# flashes a console window (cmd/mingw64) that opens and immediately closes.
# When the daemon or a cron-triggered watch run fires many child processes
# (git fetch per repo, shell probes, helper scripts) the screen flickers with
# transient windows. CREATE_NO_WINDOW suppresses them. 0 (no-op) on POSIX —
# merge into every subprocess call's kwargs via `creationflags=NO_WINDOW`.
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0


def resolve_output_dir(
    path: str, project_dir: str, active_run_file: str = DEFAULT_ACTIVE_RUN_FILE
) -> str:
    """Replace ``${OUTPUT_DIR}`` in *path* using the active-run file.

    The active-run file (a small JSON written by the supervised launcher) carries
    ``{"output_dir": ...}`` so components can follow a task whose output location
    is only known at runtime. *active_run_file* is configurable so two separate
    watch configs can each point at their own run file; it defaults to the
    single shared ``.claude/watch/active-run.json``. Returns *path* unchanged if
    the template is absent or the file is missing/unreadable.
    """
    if '${OUTPUT_DIR}' not in path:
        return path
    ar = Path(active_run_file)
    if not ar.is_absolute():
        ar = Path(project_dir) / ar
    try:
        if ar.exists():
            data = json.loads(ar.read_text(encoding='utf-8'))
            return path.replace('${OUTPUT_DIR}', data.get('output_dir', ''))
    except Exception:
        pass
    return path


@dataclass
class Anomaly:
    type: str
    severity: str  # warning | critical
    message: str
    value: float | None = None
    threshold: float | None = None
    source: str = ''
    # Stable identity used to dedup repeat alerts (alerts.suppress_after_n_identical).
    # Empty → the message is used. Set this to a value that stays constant while the
    # underlying condition is unchanged (e.g. the dirty commit sha) but changes when
    # the situation genuinely moves, so suppression releases on real change.
    signature: str = ''


@dataclass
class RemedyStep:
    action: str
    on: str = 'always'               # warning | critical | always
    condition: str | None = None      # e.g. "$new_commits > 0"
    max_attempts: int = 1
    escalate_after: int | None = None


@dataclass
class Action:
    description: str = ''
    command: str | None = None        # shell command
    kill: str | list[str] | None = None  # for restart: kill existing
    start: str | list[str] | None = None  # for restart: start new
    wait: int = 3                     # for restart: wait after kill
    shell: bool = False
    timeout: int = 30
    fetch_before: bool = True         # for rollback
    set_var: dict[str, str] | None = None  # set context variables
    # Managed-service form — the executor resolves the plugin's bundled
    # kill-server.py / start-server.py itself, so config never hand-writes the
    # "locate plugin scripts dir + shell out" boilerplate. Cross-platform and
    # project-agnostic. start_dir / start_log are relative to the project dir.
    kill_port: str | int | list | None = None  # port(s) to free before (re)starting
    kill_pattern: str | None = None            # process-name pattern to kill
    setup_cmd: str | None = None               # one-shot idempotent init before the
                                               # first start_cmd (e.g. `yarn install`,
                                               # `uv sync`); skipped once it has
                                               # succeeded for the current command
    start_cmd: str | None = None               # command to spawn detached
    start_dir: str | None = None               # cwd for setup_cmd/start_cmd (rel. to project dir)
    start_dir_env: str | None = None           # env var naming an absolute cwd; when set and
                                               # present it overrides start_dir (e.g. a deploy
                                               # gate exports a dynamic staging path). Falls
                                               # back to start_dir when the var is unset.
    start_log: str | None = None               # stdout/stderr log (rel. to project dir)
    verify_port: str | int | list | None = None  # after start, confirm the process is
                                               # actually LISTENing on this port — catches
                                               # a start_cmd that binds the wrong port
    verify_timeout: int = 10                   # seconds to wait for verify_port to come up
    steps: list[str] | None = None             # compose other named actions in order


@dataclass
class CheckResult:
    metrics: dict[str, float] = field(default_factory=dict)
    anomalies: list[Anomaly] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    # Terminal "task finished successfully" signals — NOT anomalies. A completion
    # never makes a run `degraded` and never enters remedies/escalation; it lets
    # the loop report a first-class `complete` status. Each item is a small dict,
    # e.g. {'type': 'complete', 'ops_done': N, 'total_ops': N, 'message': ...}.
    completions: list[dict] = field(default_factory=list)


class Component(ABC):
    """Pluggable health check component.

    Subclass this, implement check(), and optionally remedies() / actions().
    Place custom components in .claude/watch/components/ — auto-discovered.
    """

    name: str = ''
    description: str = ''

    @abstractmethod
    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        """Run the health check. Returns metrics + anomalies."""
        ...

    def remedies(self) -> dict[str, list[RemedyStep]]:
        """anomaly_type → ordered remedy chain."""
        return {}

    def actions(self) -> dict[str, Action]:
        """Actions this component provides (referenced by remedies)."""
        return {}


def run_command(cmd: str, *, shell: bool = False, cwd: str = '',
                timeout: int = 30) -> tuple[int, str, str]:
    """Run a shell command, return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(
            cmd, shell=shell, cwd=cwd or None,
            capture_output=True, text=True, timeout=timeout,
            creationflags=NO_WINDOW,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, '', f'timed out after {timeout}s'
    except Exception as e:
        return -1, '', str(e)
