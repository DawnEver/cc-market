"""Component interface — every health check is a Component."""

from __future__ import annotations

import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Anomaly:
    type: str
    severity: str  # warning | critical
    message: str
    value: float | None = None
    threshold: float | None = None
    source: str = ''


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
    start_cmd: str | None = None               # command to spawn detached
    start_dir: str | None = None               # cwd for start_cmd (rel. to project dir)
    start_log: str | None = None               # stdout/stderr log (rel. to project dir)
    steps: list[str] | None = None             # compose other named actions in order


@dataclass
class CheckResult:
    metrics: dict[str, float] = field(default_factory=dict)
    anomalies: list[Anomaly] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)


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
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, '', f'timed out after {timeout}s'
    except Exception as e:
        return -1, '', str(e)
