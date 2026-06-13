"""ProgressTracker component — JSON progress file monitor with stall detection."""

from __future__ import annotations

import json
from pathlib import Path

from components.base import (
    DEFAULT_ACTIVE_RUN_FILE,
    Anomaly,
    CheckResult,
    Component,
    resolve_output_dir,
)


class ProgressTracker(Component):
    name = 'progress_tracker'
    description = 'Monitor JSON progress file, detect stalls and completion'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        progress_file = comp_cfg.get('progress_file', '')
        count_path = comp_cfg.get('count_path', '')
        count_field = comp_cfg.get('count_field', 'count')
        combine = comp_cfg.get('combine', 'min')
        total_ops_path = comp_cfg.get('total_ops_path', '')
        total_ops_key = comp_cfg.get('total_ops_key', 'total_ops')
        total_ops = comp_cfg.get('total_ops', 0)
        state_key = comp_cfg.get('state_key', '_progress')
        stale_threshold = comp_cfg.get('stale_threshold', 3)
        active_run_file = comp_cfg.get('active_run_file', DEFAULT_ACTIVE_RUN_FILE)

        result = CheckResult()
        project_dir = global_cfg.get('_project_dir', '.')

        # Resolve progress file path (handles ${OUTPUT_DIR} template)
        progress_file = resolve_output_dir(progress_file, project_dir, active_run_file)
        pf = Path(progress_file)
        if not pf.is_absolute():
            pf = Path(project_dir) / pf

        if not pf.exists():
            result.data['status'] = 'NO_DATA'
            result.metrics['ops_done'] = 0
            result.metrics['total_ops'] = total_ops
            result.metrics['percent'] = 0.0
            result.metrics['stale_polls'] = 0
            return result

        # Read progress JSON
        try:
            data = json.loads(pf.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            result.data['status'] = 'NO_DATA'
            result.metrics['ops_done'] = 0
            result.metrics['total_ops'] = total_ops
            result.metrics['percent'] = 0.0
            result.metrics['stale_polls'] = 0
            return result

        # Navigate count_path (dot-separated keys)
        target = data
        if count_path:
            for key in count_path.split('.'):
                if isinstance(target, dict):
                    target = target.get(key, {})
                else:
                    target = {}
                    break

        # Extract counts
        if isinstance(target, dict):
            counts = [v.get(count_field, 0) if isinstance(v, dict) else v
                      for v in target.values()]
        elif isinstance(target, list):
            counts = [v.get(count_field, 0) if isinstance(v, dict) else v
                      for v in target]
        elif isinstance(target, (int, float)):
            counts = [target]
        else:
            counts = []

        # Combine
        if not counts:
            ops_done = 0
        elif combine == 'sum':
            ops_done = sum(counts)
        elif combine == 'max':
            ops_done = max(counts)
        elif combine == 'first':
            ops_done = counts[0] if counts else 0
        else:  # min (default)
            ops_done = min(counts)

        # Resolve total_ops
        if total_ops <= 0 and total_ops_path:
            tp = Path(total_ops_path)
            if not tp.is_absolute():
                tp = Path(project_dir) / tp
            if tp.exists():
                try:
                    cfg = json.loads(tp.read_text(encoding='utf-8'))
                    total_ops = cfg.get(total_ops_key, 0)
                except (json.JSONDecodeError, OSError):
                    pass

        pct = min(100.0, round(ops_done / total_ops * 100, 1)) if total_ops > 0 else 0.0

        # Stall detection via state persistence
        last_ops_key = f'{state_key}_last_ops'
        stale_key = f'{state_key}_stale'

        last_ops = state.get(last_ops_key, -1)
        stale = state.get(stale_key, 0)

        if ops_done == last_ops:
            stale += 1
        else:
            stale = 0

        state[last_ops_key] = ops_done
        state[stale_key] = stale

        # Status
        if ops_done >= total_ops and total_ops > 0:
            status = 'COMPLETE'
        elif stale >= stale_threshold and total_ops > 0:
            status = 'STALLED'
        else:
            status = 'RUNNING'

        result.metrics['ops_done'] = ops_done
        result.metrics['total_ops'] = total_ops
        result.metrics['percent'] = pct
        result.metrics['stale_polls'] = stale
        result.data['status'] = status
        result.data['ops_done'] = ops_done
        result.data['total_ops'] = total_ops
        result.data['stale_polls'] = stale
        result.data['last_ops'] = last_ops

        if status == 'STALLED':
            result.anomalies.append(Anomaly(
                type='stalled',
                severity='critical',
                value=ops_done,
                threshold=total_ops,
                message=f'Progress stalled: {ops_done}/{total_ops} OPs unchanged for {stale} polls',
            ))
        elif status == 'COMPLETE':
            # Terminal success — a completion, NOT an anomaly. Modelling it as a
            # (warning) anomaly made a finished run read as `degraded` forever,
            # held it on the anomaly cadence, and could trip escalation. As a
            # completion it yields a first-class `complete` status instead.
            result.completions.append({
                'type': 'complete',
                'ops_done': ops_done,
                'total_ops': total_ops,
                'message': f'Task complete: {ops_done}/{total_ops} OPs',
            })

        return result
