"""Process monitor component — psutil-based process presence, RSS, CPU checks,
peak tracking, and cross-platform system resource snapshot."""

from __future__ import annotations

from components.base import Anomaly, CheckResult, Component


class ProcessMonitor(Component):
    name = 'process_monitor'
    description = 'Monitor processes — presence, RSS, CPU% via psutil, with peak tracking and system snapshot'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        processes = comp_cfg.get('processes', [])
        track_system = comp_cfg.get('track_system', False)
        result = CheckResult()
        if not processes and not track_system:
            return result

        try:
            import psutil
        except ImportError:
            result.anomalies.append(Anomaly(
                type='no_psutil', severity='warning',
                message='psutil not installed; process checks skipped'))
            return result

        # ── Process monitoring ─────────────────────────────────────────────
        stats: dict[str, dict] = {}
        for proc in psutil.process_iter(['name', 'memory_info', 'cmdline', 'cpu_percent']):
            try:
                pinfo = proc.info
                pname = (pinfo.get('name') or '').lower()
                cmdline = ' '.join(pinfo.get('cmdline') or [])
                rss_mb = ((pinfo.get('memory_info') or type('m', (), {'rss': 0})()).rss) / (1024 * 1024)
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

            # ── Peak tracking ──────────────────────────────────────────────
            if pc.get('track_peaks'):
                peak_rss_key = f'_pm_peak_rss_{name}'
                peak_cpu_key = f'_pm_peak_cpu_{name}'
                prev_rss = state.get(peak_rss_key, 0.0)
                prev_cpu = state.get(peak_cpu_key, 0.0)
                if s['rss_mb'] > prev_rss:
                    state[peak_rss_key] = s['rss_mb']
                if s['cpu_pct'] > prev_cpu:
                    state[peak_cpu_key] = s['cpu_pct']
                s['peak_rss_mb'] = round(state.get(peak_rss_key, 0.0), 2)
                s['peak_cpu_pct'] = round(state.get(peak_cpu_key, 0.0), 2)

            result.data[name] = s

            min_c = pc.get('min_count')
            if min_c is not None and s['count'] < min_c:
                result.anomalies.append(Anomaly(
                    type=f'{name}_count_low', severity='critical', value=s['count'],
                    threshold=min_c, message=f"Process '{name}': {s['count']} < min {min_c}",
                ))

            max_rss = pc.get('max_rss_mb')
            if max_rss is not None and s['rss_mb'] > max_rss:
                result.anomalies.append(Anomaly(
                    type=f'{name}_high_ram', severity='critical', value=s['rss_mb'],
                    threshold=max_rss, message=f"Process '{name}': {s['rss_mb']}MB > {max_rss}MB",
                ))

        # ── System resource snapshot ───────────────────────────────────────
        if track_system:
            cpu = psutil.cpu_percent()
            mem = psutil.virtual_memory()
            ram_pct = mem.percent
            avail_mb = round(mem.available / (1024 * 1024), 1)

            result.metrics['system_cpu_percent'] = cpu
            result.metrics['system_ram_percent'] = ram_pct
            result.metrics['system_ram_available_mb'] = avail_mb
            result.data['system'] = {
                'cpu_percent': cpu,
                'ram_percent': ram_pct,
                'ram_available_mb': avail_mb,
                'ram_total_gb': round(mem.total / (1024 ** 3), 1),
            }

            if ram_pct > 95:
                result.anomalies.append(Anomaly(
                    type='system_ram_critical', severity='critical', value=ram_pct,
                    threshold=95, message=f'System RAM critical: {ram_pct:.1f}% ({avail_mb:.0f} MB free)',
                ))
            elif ram_pct > 90:
                result.anomalies.append(Anomaly(
                    type='system_ram_high', severity='warning', value=ram_pct,
                    threshold=90, message=f'System RAM high: {ram_pct:.1f}% ({avail_mb:.0f} MB free)',
                ))

        return result
