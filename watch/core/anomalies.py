"""Shared anomaly classification — single source of truth, pure stdlib.

Kept dependency-free so the lightweight Monitor feed (`scripts/trigger-emit.py`)
can import it without `bootstrap.ensure()` / a venv re-exec.
"""

from __future__ import annotations

from collections.abc import Iterable

# Anomaly types that NO shell action can remediate — only a live agent with
# CronCreate/CronList tool access can resolve them (see components/cron_freshness.py).
# These are "parked" anomalies: they may persist indefinitely with no deterministic
# remedy, so they must not flood the real-time trigger/Monitor layers.
AI_ONLY_ANOMALY_TYPES = frozenset({'cron_stale', 'cron_marker_missing'})


def is_ai_only(anomaly_types: Iterable[str]) -> bool:
    """True iff there is at least one anomaly and EVERY type is AI-only.

    A mixed batch (one shell-remediable anomaly + one AI-only) returns False so
    the actionable anomaly still wakes the deterministic remedy/escalation path.
    """
    types = set(anomaly_types)
    return bool(types) and types <= AI_ONLY_ANOMALY_TYPES
