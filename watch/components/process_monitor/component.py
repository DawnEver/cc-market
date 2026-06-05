"""Process monitor component — psutil-based process presence, RSS, CPU checks."""

from __future__ import annotations

from components.base import Anomaly, CheckResult, Component


class ProcessMonitor(Component):
    name = 'process_monitor'
    description = 'Monitor processes — presence, RSS, CPU% via psutil'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        processes = comp_cfg.get('processes', [])
        result = CheckResult()

        if not processes:
            return result

        try:
            import psutil
        except ImportError:
            result.anomalies.append(Anomaly(
                type='no_psutil', severity='warning',
                message='psutil not installed; process checks skipped'))
            return result

        stats: dict[str, dict] = {}
        for proc in psutil.process_iter(['name', 'memory_info', 'cmdline', 'cpu_percent']):
            try:
                pinfo = proc.info
                pname = (pinfo.get('name') or '').lower()
                cmdline = ' '.join(pinfo.get('cmdline') or [])
                rss_mb = ((pinfo.get('memory_info') or
                           type('m', (), {'rss': 0})()).rss) / (1024 * 1024)
                cpu_pct = pinfo.get('cpu_percent') or 0.0
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

            for pc in processes:
                match = pc.get('match', '')
                if match and match.lower() not in pname and match.lower() not in cmdline.lower():
                    continue
                name = pc['name']
                if name not in stats:
                    stats[name] = {'count': 0, 'rss_mb': 0.0, 'cpu_pct': 0.0}
                stats[name]['count'] += 1
                stats[name]['rss_mb'] += rss_mb
                stats[name]['cpu_pct'] += cpu_pct

        for pc in processes:
            name = pc['name']
            s = stats.get(name, {'count': 0, 'rss_mb': 0.0, 'cpu_pct': 0.0})
            for k in ('rss_mb', 'cpu_pct'):
                s[k] = round(s[k], 2)
            result.metrics[f'{name}_count'] = s['count']
            result.metrics[f'{name}_rss_mb'] = s['rss_mb']
            result.data[name] = s

            min_c = pc.get('min_count')
            if min_c is not None and s['count'] < min_c:
                result.anomalies.append(Anomaly(
                    type=f'{name}_count_low', severity='critical',
                    value=s['count'], threshold=min_c,
                    message=f"Process '{name}': {s['count']} < min {min_c}",
                ))

            max_rss = pc.get('max_rss_mb')
            if max_rss is not None and s['rss_mb'] > max_rss:
                result.anomalies.append(Anomaly(
                    type=f'{name}_high_ram', severity='critical',
                    value=s['rss_mb'], threshold=max_rss,
                    message=f"Process '{name}': {s['rss_mb']}MB > {max_rss}MB",
                ))

        return result
