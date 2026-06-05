"""Shell probe component — arbitrary shell commands as health checks."""

from __future__ import annotations

from components.base import Anomaly, CheckResult, Component, run_command


class ShellProbe(Component):
    name = 'shell_probe'
    description = 'Arbitrary shell command probes — parse output, check thresholds, detect stalls'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        probes = comp_cfg.get('probes', [])
        result = CheckResult()

        for p in probes:
            name = p['name']
            cmd = p.get('command', '')
            check = p.get('check', 'value')

            rc, stdout, stderr = run_command(cmd, shell=True, timeout=p.get('timeout', 10))
            if rc != 0 and not p.get('ignore_errors'):
                result.anomalies.append(Anomaly(
                    type=f'probe_{name}_failed', severity='critical',
                    message=f"Probe '{name}' failed: {stderr or stdout}"))
                continue

            # Parse numeric value
            try:
                value = float(stdout.strip().rstrip('%'))
            except ValueError:
                value = float(bool(stdout.strip()))

            result.metrics[name] = value
            result.data[name] = value

            if check == 'delta':
                prev = state.get(f'_probe_{name}')
                if prev is not None and value == prev:
                    stale_key = f'_stale_{name}'
                    stale = state.get(stale_key, 0) + 1
                    state[stale_key] = stale
                    limit = p.get('stale_rounds', 3)
                    if stale >= limit:
                        result.anomalies.append(Anomaly(
                            type=f'{name}_stale', severity='critical',
                            value=value, message=f"Probe '{name}' stalled: {value} for {stale} rounds",
                        ))
                else:
                    state[f'_stale_{name}'] = 0
                state[f'_probe_{name}'] = value
            else:
                critical = p.get('critical')
                warning = p.get('warning')
                if critical is not None and value > critical:
                    result.anomalies.append(Anomaly(
                        type=f'probe_{name}', severity='critical', value=value,
                        threshold=critical, message=f"Probe '{name}': {value} > {critical}",
                    ))
                elif warning is not None and value > warning:
                    result.anomalies.append(Anomaly(
                        type=f'probe_{name}', severity='warning', value=value,
                        threshold=warning, message=f"Probe '{name}': {value} > {warning}",
                    ))

        return result
