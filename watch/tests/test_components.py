"""Tests for built-in components — check(), remedies(), actions()."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.base import CheckResult, Anomaly, Component
from components.disk_usage import DiskUsage
from components.http_health import HttpHealth
from components.shell_probe import ShellProbe
from components.watchd_heartbeat import WatchdHeartbeat
from components.process_monitor import ProcessMonitor


class TestDiskUsage(unittest.TestCase):
    def test_name_and_description(self):
        c = DiskUsage()
        self.assertEqual(c.name, 'disk_usage')
        self.assertIsInstance(c.description, str)

    def test_check_returns_metrics(self):
        c = DiskUsage()
        result = c.check({}, {}, {})
        self.assertIn('root_pct', result.metrics)
        self.assertIn('root_free_gb', result.metrics)

    def test_check_anomaly_on_high_usage(self):
        c = DiskUsage()
        result = c.check({'paths': [{'path': '/', 'name': 'root', 'critical': 1}]}, {}, {})
        self.assertTrue(any('root' in a.type for a in result.anomalies))

    def test_check_multiple_paths(self):
        c = DiskUsage()
        result = c.check({
            'paths': [
                {'path': '/', 'name': 'root'},
                {'path': tempfile.gettempdir(), 'name': 'tmp'},
            ],
        }, {}, {})
        self.assertIn('root_pct', result.metrics)
        self.assertIn('tmp_pct', result.metrics)


class TestHttpHealth(unittest.TestCase):
    def test_name_and_description(self):
        c = HttpHealth()
        self.assertEqual(c.name, 'http_health')
        self.assertIsInstance(c.description, str)

    def test_check_empty_endpoints_returns_empty(self):
        c = HttpHealth()
        result = c.check({}, {}, {})
        self.assertEqual(result.metrics, {})
        self.assertEqual(result.anomalies, [])

    def test_fetch_unreachable_returns_anomaly(self):
        c = HttpHealth()
        result = c.check({
            'endpoints': [{'name': 'dead', 'url': 'http://127.0.0.1:19999'}],
        }, {}, {})
        self.assertTrue(any('unreachable' in a.type for a in result.anomalies))

    def test_optional_endpoint_warning(self):
        c = HttpHealth()
        result = c.check({
            'endpoints': [{'name': 'opt', 'url': 'http://127.0.0.1:19999', 'optional': True}],
        }, {}, {})
        self.assertTrue(any(a.severity == 'warning' for a in result.anomalies))


class TestShellProbe(unittest.TestCase):
    def test_name_and_description(self):
        c = ShellProbe()
        self.assertEqual(c.name, 'shell_probe')
        self.assertIsInstance(c.description, str)

    def test_check_empty_probes_returns_empty(self):
        c = ShellProbe()
        result = c.check({}, {}, {})
        self.assertEqual(result.metrics, {})
        self.assertEqual(result.anomalies, [])

    def test_check_value_probe(self):
        c = ShellProbe()
        result = c.check({
            'probes': [{'name': 'test', 'command': 'echo 42', 'check': 'value'}],
        }, {}, {})
        self.assertEqual(result.metrics['test'], 42.0)

    def test_check_failed_probe_returns_anomaly(self):
        c = ShellProbe()
        result = c.check({
            'probes': [{'name': 'bad', 'command': 'exit 1'}],
        }, {}, {})
        self.assertTrue(any('failed' in a.type for a in result.anomalies))

    def test_check_delta_stale_detection(self):
        c = ShellProbe()
        state = {'_probe_lines': 10}
        result = c.check({
            'probes': [{'name': 'lines', 'command': 'echo 10', 'check': 'delta'}],
        }, {}, state)
        self.assertEqual(state['_stale_lines'], 1)

    def test_check_delta_stale_anomaly(self):
        c = ShellProbe()
        state = {'_probe_lines': 10, '_stale_lines': 2}
        result = c.check({
            'probes': [{'name': 'lines', 'command': 'echo 10', 'check': 'delta', 'stale_rounds': 2}],
        }, {}, state)
        self.assertTrue(any('stale' in a.type for a in result.anomalies))


class TestComponentBase(unittest.TestCase):
    def test_check_result_defaults(self):
        r = CheckResult()
        self.assertEqual(r.metrics, {})
        self.assertEqual(r.anomalies, [])
        self.assertEqual(r.data, {})

    def test_anomaly_fields(self):
        a = Anomaly(type='disk_full', severity='critical', message='Disk full', value=99.0, threshold=95.0)
        self.assertEqual(a.type, 'disk_full')
        self.assertEqual(a.severity, 'critical')

    def test_component_defaults(self):
        class MyComp(Component):
            name = 'my'
            description = 'test'
            def check(self, comp_cfg, global_cfg, state):
                return CheckResult()

        c = MyComp()
        self.assertEqual(c.remedies(), {})
        self.assertEqual(c.actions(), {})


class TestWatchdHeartbeat(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_heartbeat(self, ts, pid=12345):
        hb = self.project / 'heartbeat.json'
        hb.parent.mkdir(parents=True, exist_ok=True)
        hb.write_text(json.dumps({'ts': ts, 'pid': pid}))

    def test_name_and_description(self):
        c = WatchdHeartbeat()
        self.assertEqual(c.name, 'watchd_heartbeat')
        self.assertIsInstance(c.description, str)

    def test_missing_heartbeat_returns_anomaly(self):
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': 'heartbeat.json'}}
        result = c.check({}, cfg, {})
        self.assertEqual(len(result.anomalies), 1)
        self.assertEqual(result.anomalies[0].type, 'daemon_heartbeat_missing')

    def test_fresh_heartbeat_returns_no_anomaly(self):
        now = datetime.now(timezone.utc).isoformat()
        self._write_heartbeat(now)
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': 'heartbeat.json'}}
        result = c.check({}, cfg, {})
        self.assertEqual(len(result.anomalies), 0)
        self.assertIn('heartbeat_age_seconds', result.metrics)
        self.assertLess(result.metrics['heartbeat_age_seconds'], 5)

    def test_stale_heartbeat_returns_anomaly(self):
        stale = (datetime.now(timezone.utc) - timedelta(seconds=700)).isoformat()
        self._write_heartbeat(stale)
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': 'heartbeat.json'}}
        result = c.check({'max_age_seconds': 600}, cfg, {})
        self.assertEqual(len(result.anomalies), 1)
        self.assertEqual(result.anomalies[0].type, 'daemon_heartbeat_stale')
        self.assertGreater(result.metrics['heartbeat_age_seconds'], 600)

    def test_corrupt_heartbeat_returns_anomaly(self):
        hb = self.project / 'heartbeat.json'
        hb.write_text('not json')
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': 'heartbeat.json'}}
        result = c.check({}, cfg, {})
        self.assertEqual(len(result.anomalies), 1)
        self.assertEqual(result.anomalies[0].type, 'daemon_heartbeat_error')

    def test_heartbeat_includes_pid_in_data(self):
        now = datetime.now(timezone.utc).isoformat()
        self._write_heartbeat(now, pid=99999)
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': 'heartbeat.json'}}
        result = c.check({}, cfg, {})
        self.assertEqual(result.data['daemon_pid'], 99999)

    def test_uses_default_heartbeat_path_from_config(self):
        hb = self.project / '.claude' / 'watch' / 'state' / 'heartbeat.json'
        hb.parent.mkdir(parents=True, exist_ok=True)
        hb.write_text(json.dumps({
            'ts': datetime.now(timezone.utc).isoformat(),
            'pid': 1,
        }))
        c = WatchdHeartbeat()
        cfg = {'_project_dir': str(self.project),
               'watchd': {'heartbeat_file': '.claude/watch/state/heartbeat.json'}}
        result = c.check({}, cfg, {})
        self.assertEqual(len(result.anomalies), 0)


class TestProcessMonitorPeak(unittest.TestCase):
    def test_peak_tracking_stores_in_state(self):
        c = ProcessMonitor()
        state = {}
        c.check({
            'processes': [{'name': 'testproc', 'match': 'nonexistent_process_xyz', 'track_peaks': True}],
        }, {}, state)
        self.assertEqual(state.get('_pm_peak_rss_testproc', 0.0), 0.0)

    def test_system_snapshot_adds_metrics(self):
        c = ProcessMonitor()
        result = c.check({'track_system': True}, {}, {})
        self.assertIn('system_cpu_percent', result.metrics)
        self.assertIn('system_ram_percent', result.metrics)
        self.assertIn('system_ram_available_mb', result.metrics)
        self.assertIn('system', result.data)

    def test_backward_compat_without_new_keys(self):
        c = ProcessMonitor()
        result = c.check({
            'processes': [{'name': 'nonexistent_xyz'}],
        }, {}, {})
        self.assertIsInstance(result, CheckResult)
        self.assertNotIn('system_cpu_percent', result.metrics)


if __name__ == '__main__':
    unittest.main()
