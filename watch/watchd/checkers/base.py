"""Checker interface — each checker is a module with check(config, state) -> CheckResult."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class CheckResult:
    ok: bool = True
    metrics: dict[str, Any] = field(default_factory=dict)
    anomalies: list[str] = field(default_factory=list)
