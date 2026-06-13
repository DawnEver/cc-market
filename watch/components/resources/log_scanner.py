"""LogScanner component — cross-platform log file scanner for error detection."""

from __future__ import annotations

from pathlib import Path

from components.base import (
    DEFAULT_ACTIVE_RUN_FILE,
    Anomaly,
    CheckResult,
    Component,
    resolve_output_dir,
)


class LogScanner(Component):
    name = 'log_scanner'
    description = 'Scan log file tails for error patterns — cross-platform, no shell'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        log_dir = comp_cfg.get('log_dir', '')
        glob_pattern = comp_cfg.get('glob', '*.log')
        tail_lines = comp_cfg.get('tail_lines', 5)
        error_patterns = comp_cfg.get('error_patterns', ['FAIL', 'ERROR', 'Traceback'])
        max_files = comp_cfg.get('max_files', 10)
        active_run_file = comp_cfg.get('active_run_file', DEFAULT_ACTIVE_RUN_FILE)

        result = CheckResult()

        if not log_dir:
            result.data['status'] = 'NO_LOG_DIR'
            result.metrics['files_scanned'] = 0
            result.metrics['error_count'] = 0
            return result

        project_dir = global_cfg.get('_project_dir', '.')
        log_dir = resolve_output_dir(log_dir, project_dir, active_run_file)
        log_path = Path(project_dir) / log_dir if not Path(log_dir).is_absolute() else Path(log_dir)

        if not log_path.exists() or not log_path.is_dir():
            result.data['status'] = 'NO_LOG_DIR'
            result.metrics['files_scanned'] = 0
            result.metrics['error_count'] = 0
            return result

        log_files = sorted(log_path.glob(glob_pattern), key=lambda p: p.stat().st_mtime, reverse=True)
        log_files = log_files[:max_files]

        errors: list[dict] = []
        files_scanned = 0

        for f in log_files:
            try:
                content = f.read_text(errors='replace')
                lines = content.splitlines()
                tail = lines[-tail_lines:] if len(lines) > tail_lines else lines
                for line in tail:
                    for kw in error_patterns:
                        if kw in line:
                            errors.append({
                                'file': f.name,
                                'line': line.strip()[:200],
                                'keyword': kw,
                            })
                files_scanned += 1
            except Exception:
                continue

        result.metrics['files_scanned'] = files_scanned
        result.metrics['error_count'] = len(errors)
        result.data['errors'] = errors

        if errors:
            result.data['status'] = 'ERRORS_FOUND'
            result.anomalies.append(Anomaly(
                type='errors_detected',
                severity='critical',
                value=len(errors),
                threshold=0,
                message=f'{len(errors)} error(s) found in {files_scanned} log file(s)',
            ))
        else:
            result.data['status'] = 'CLEAN'

        return result
