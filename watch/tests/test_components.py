"""Tests for built-in components — check(), remedies(), actions()."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.base import CheckResult, Anomaly, Component
from components.disk_usage import DiskUsage
from components.http_health import HttpHealth
from components.shell_probe import ShellProbe


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
                {'path': '/tmp', 'name': 'tmp'},
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


if __name__ == '__main__':
    unittest.main()
