"""Deterministic remedy application — shared by the AI loop (core.loop) and
the headless watchd daemon (watchd.daemon) so both apply the exact same
remedy chains with zero duplicate logic."""

from __future__ import annotations

import sys
from pathlib import Path

from core.actions import _execute_action, _eval_condition
from core.daemon_helpers import _escalate
from core.state import (track_anomaly, record_remedy_attempt, set_alert_sent,
                        register_alert_signature)


def apply_remedies(registry, anomalies: list, config: dict, state: dict,
                   project: Path, ts: str, report: dict | None = None,
                   dry_run: bool = False) -> None:
    """Apply remedy chains for each anomaly. Mutates `state` in place.

    `anomalies` is a list of Anomaly objects with `.source` set to
    `'<component>.<type>'`. `report` is only used for escalation alert
    context (its `timestamp`); a minimal dict is synthesised if omitted.
    """
    if report is None:
        report = {'timestamp': ts, 'instance': config.get('instance', {}).get('name', '')}

    context: dict[str, object] = {}
    for anomaly in anomalies:
        steps = registry.get_remedies(anomaly.type)
        if not steps or (len(steps) == 1 and steps[0].action == 'log'):
            track_anomaly(state, anomaly.type)
            continue

        print(f'  [{anomaly.type}] applying remedies...', file=sys.stderr, flush=True)
        for step in steps:
            if step.on != 'always' and step.on != anomaly.severity:
                continue
            if step.condition and not _eval_condition(step.condition, state):
                continue

            action = registry.get_action(step.action)
            if not action:
                print(f'    action "{step.action}" not found, skipping', file=sys.stderr)
                continue

            for attempt in range(step.max_attempts):
                ok = _execute_action(action, project, registry,
                                     anomaly.source or '', context)
                if ok:
                    record_remedy_attempt(state, anomaly.type, step.action, 'ok', attempt + 1)
                    break
                print(f'    retry {attempt + 1}/{step.max_attempts}', file=sys.stderr)
            else:
                record_remedy_attempt(state, anomaly.type, step.action, 'failed', step.max_attempts)

            if step.escalate_after:
                escalate_count = track_anomaly(state, anomaly.type)
                if escalate_count >= step.escalate_after:
                    suppress_after = config.get('alerts', {}).get(
                        'suppress_after_n_identical', 0)
                    sig = anomaly.signature or anomaly.message
                    if register_alert_signature(state, anomaly.type, sig, suppress_after):
                        print(f'    [{anomaly.type}] alert suppressed — identical '
                              f'signature unchanged after {suppress_after} alerts',
                              file=sys.stderr)
                    else:
                        _escalate(config, anomaly, escalate_count, report, dry_run)
                        set_alert_sent(state, ts)
