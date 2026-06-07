"""HTTP endpoint health check component."""

from __future__ import annotations

import json
import socket
from urllib.parse import urlparse

from components.base import Anomaly, CheckResult, Component


class HttpHealth(Component):
    name = 'http_health'
    description = 'Monitor HTTP endpoints — fetch health JSON, compare thresholds'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        endpoints = comp_cfg.get('endpoints', [])
        thresholds = comp_cfg.get('thresholds', [])
        result = CheckResult()
        endpoint_data: dict[str, dict] = {}

        for ep in endpoints:
            name = ep.get('name', ep['url'])
            ep_result = self._fetch(ep)
            endpoint_data[name] = ep_result

            if not ep_result['reachable']:
                sev = 'warning' if ep.get('optional') else 'critical'
                result.anomalies.append(Anomaly(
                    type='endpoint_unreachable' if sev == 'critical' else f'{name}_unreachable',
                    severity=sev,
                    message=f"Endpoint '{name}' unreachable: {ep_result['error']}",
                ))
                continue
            result.data[name] = ep_result['body']

        for t in thresholds:
            value = self._resolve(t['source'], endpoint_data)
            if value is None:
                continue
            result.metrics[t['name']] = value
            critical = t.get('critical')
            warning = t.get('warning')
            if critical is not None and value > critical:
                result.anomalies.append(Anomaly(
                    type=t['name'], severity='critical', value=value,
                    threshold=critical, message=f"{t['name']}: {value} > {critical}",
                ))
            elif warning is not None and value > warning:
                result.anomalies.append(Anomaly(
                    type=t['name'], severity='warning', value=value,
                    threshold=warning, message=f"{t['name']}: {value} > {warning}",
                ))
        return result

    def _fetch(self, ep: dict) -> dict:
        url = ep['url'].rstrip('/')
        path = ep.get('health_path', '/')
        timeout = ep.get('timeout', 5)

        try:
            parsed = urlparse(url)
            host = parsed.hostname or 'localhost'
            port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        except Exception:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': f'invalid URL: {url}'}

        sock = None
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            sock.settimeout(timeout)
            request = (
                f"GET {path} HTTP/1.0\r\n"
                f"Host: {host}\r\n"
                f"User-Agent: watch/1.0\r\n"
                f"Accept: application/json\r\n"
                f"\r\n"
            )
            sock.sendall(request.encode())
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk

            text = response.decode('utf-8')
            status_line = text.split('\r\n')[0]
            status_code = int(status_line.split(' ')[1])
            body_start = text.index('\r\n\r\n') + 4
            body = json.loads(text[body_start:])
            return {'reachable': True, 'status_code': status_code, 'body': body, 'error': ''}
        except socket.timeout:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': f'timed out after {timeout}s'}
        except ConnectionRefusedError:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': 'connection refused'}
        except socket.gaierror as e:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': f'DNS: {e}'}
        except OSError as e:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': str(e)}
        except Exception as e:
            return {'reachable': False, 'status_code': 0, 'body': None, 'error': str(e)}
        finally:
            if sock:
                sock.close()

    def _resolve(self, source: str, data: dict) -> float | None:
        if not source.startswith('endpoint.'):
            return None
        parts = source.split('.', 2)
        ep_name = parts[1] if len(parts) > 1 else 'backend'
        jp = parts[2] if len(parts) > 2 else '$'
        body = data.get(ep_name)
        if body is None:
            return None
        return self._jsonpath(body, jp)

    def _jsonpath(self, obj, path: str) -> float | None:
        if not path.startswith('$'):
            return None
        segs = path[1:].strip('.').split('.')
        cur = obj
        for seg in segs:
            if seg == '*' and isinstance(cur, dict):
                return sum(float(v) for v in cur.values() if isinstance(v, (int, float)))
            if isinstance(cur, dict):
                cur = cur.get(seg)
            else:
                return None
            if cur is None:
                return None
        return float(cur) if isinstance(cur, (int, float)) else None
