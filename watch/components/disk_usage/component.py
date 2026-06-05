"""Disk usage component."""

from __future__ import annotations

import shutil

from components.base import Anomaly, CheckResult, Component


class DiskUsage(Component):
    name = 'disk_usage'
    description = 'Check disk usage percentage against thresholds'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        paths = comp_cfg.get('paths', [{'path': '/', 'name': 'root'}])
        result = CheckResult()

        for entry in paths:
            path = entry.get('path', '/')
            name = entry.get('name', path)
            try:
                usage = shutil.disk_usage(path)
                pct = round((usage.used / usage.total) * 100, 2)
                result.metrics[f'{name}_pct'] = pct
                result.metrics[f'{name}_free_gb'] = round(usage.free / (1024 ** 3), 2)

                critical = entry.get('critical', 95)
                warning = entry.get('warning', 85)
                if pct > critical:
                    result.anomalies.append(Anomaly(
                        type=f'{name}_disk_full', severity='critical', value=pct,
                        threshold=critical, message=f"Disk '{name}': {pct}% > {critical}%",
                    ))
                elif pct > warning:
                    result.anomalies.append(Anomaly(
                        type=f'{name}_disk_full', severity='warning', value=pct,
                        threshold=warning, message=f"Disk '{name}': {pct}% > {warning}%",
                    ))
            except Exception as e:
                result.anomalies.append(Anomaly(
                    type='disk_check_failed', severity='warning',
                    message=f"Disk check '{name}' failed: {e}",
                ))

        return result
