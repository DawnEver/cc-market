"""Tests for built-in components — check(), remedies(), actions()."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.base import CheckResult, Anomaly, Component
from components.disk_usage import DiskUsage
from components.http_health import HttpHealth
from components.shell_probe import ShellProbe
from components.watchd_heartbeat import WatchdHeartbeat
from components.log_scanner import LogScanner
from components.progress_tracker import ProgressTracker
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


class TestLogScanner(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_log(self, name, *lines):
        f = self.log_dir / name
        f.write_text('\n'.join(lines), encoding='utf-8')

    def test_name_and_description(self):
        c = LogScanner()
        self.assertEqual(c.name, 'log_scanner')
        self.assertIsInstance(c.description, str)

    def test_no_log_dir_returns_clean(self):
        c = LogScanner()
        result = c.check({}, {}, {})
        self.assertEqual(result.data['status'], 'NO_LOG_DIR')
        self.assertEqual(result.metrics['error_count'], 0)
        self.assertEqual(len(result.anomalies), 0)

    def test_missing_log_dir_returns_clean(self):
        c = LogScanner()
        result = c.check({'log_dir': '/nonexistent/path'}, {}, {})
        self.assertEqual(result.data['status'], 'NO_LOG_DIR')

    def test_clean_logs_no_anomaly(self):
        self._write_log('a.log', 'INFO: starting', 'DEBUG: running', 'INFO: done')
        self._write_log('b.log', 'Processing OK', 'Task complete')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertEqual(result.data['status'], 'CLEAN')
        self.assertEqual(result.metrics['error_count'], 0)
        self.assertEqual(len(result.anomalies), 0)

    def test_errors_found_detects_anomaly(self):
        self._write_log('a.log', 'Running', 'ERROR: something broke', 'Exiting')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertEqual(result.data['status'], 'ERRORS_FOUND')
        self.assertGreaterEqual(result.metrics['error_count'], 1)
        self.assertEqual(len(result.anomalies), 1)
        self.assertEqual(result.anomalies[0].type, 'errors_detected')

    def test_multiple_error_patterns(self):
        self._write_log('a.log', 'FAIL: init', 'line2', 'line3', 'line4', 'ERROR: mid')
        self._write_log('b.log', 'line1', 'Traceback: boom', 'line3', 'line4', 'line5')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertGreaterEqual(result.metrics['error_count'], 2)

    def test_tail_lines_only_scanned(self):
        lines = ['line' + str(i) for i in range(20)]
        lines[-1] = 'ERROR: at the very end'
        self._write_log('a.log', *lines)
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir), 'tail_lines': 3}, {}, {})
        self.assertEqual(result.metrics['error_count'], 1)
        # An error above the tail window should not be found
        error_files = [e['file'] for e in result.data['errors']]
        self.assertIn('a.log', error_files)

    def test_respects_max_files(self):
        for i in range(5):
            self._write_log(f'{i}.log', f'ERROR in file {i}')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir), 'max_files': 2}, {}, {})
        self.assertEqual(result.metrics['files_scanned'], 2)

    def test_custom_error_patterns(self):
        self._write_log('a.log', 'WARNING: disk low', 'INFO: ok')
        c = LogScanner()
        result = c.check({
            'log_dir': str(self.log_dir),
            'error_patterns': ['WARNING'],
        }, {}, {})
        self.assertEqual(result.metrics['error_count'], 1)


class TestProgressTracker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_json(self, rel_path, data):
        p = self.proj / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data), encoding='utf-8')

    def test_name_and_description(self):
        c = ProgressTracker()
        self.assertEqual(c.name, 'progress_tracker')
        self.assertIsInstance(c.description, str)

    def test_no_progress_file_returns_no_data(self):
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({'progress_file': 'does_not_exist.json'}, cfg, {})
        self.assertEqual(result.data['status'], 'NO_DATA')
        self.assertEqual(len(result.anomalies), 0)

    def test_counting_with_count_path(self):
        self._write_json('timing.json', {
            'models': {
                '2d': {'count': 10, 'mean_s': 30},
                '3d': {'count': 5, 'mean_s': 60},
            },
        })
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json',
            'count_path': 'models',
        }, cfg, {})
        self.assertEqual(result.metrics['ops_done'], 5)  # min of 10, 5

    def test_combine_sum(self):
        self._write_json('timing.json', {
            'models': {
                'a': {'count': 10},
                'b': {'count': 5},
            },
        })
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json',
            'count_path': 'models',
            'combine': 'sum',
        }, cfg, {})
        self.assertEqual(result.metrics['ops_done'], 15)

    def test_combine_first(self):
        self._write_json('timing.json', {
            'items': [{'count': 99}, {'count': 1}],
        })
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json',
            'count_path': 'items',
            'combine': 'first',
        }, cfg, {})
        self.assertEqual(result.metrics['ops_done'], 99)

    def test_total_ops_from_file(self):
        self._write_json('timing.json', {'models': {'a': {'count': 42}}})
        self._write_json('.claude/watch/active-run.json', {'total_ops': 100})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json',
            'count_path': 'models',
            'total_ops_path': '.claude/watch/active-run.json',
        }, cfg, {})
        self.assertEqual(result.metrics['total_ops'], 100)
        self.assertEqual(result.metrics['percent'], 42.0)

    def test_hardcoded_total_ops_overrides_file(self):
        self._write_json('timing.json', {'models': {'a': {'count': 42}}})
        self._write_json('.claude/watch/active-run.json', {'total_ops': 100})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json',
            'count_path': 'models',
            'total_ops': 200,
            'total_ops_path': '.claude/watch/active-run.json',
        }, cfg, {})
        self.assertEqual(result.metrics['total_ops'], 200)

    def test_stall_detection(self):
        self._write_json('timing.json', {'models': {'a': {'count': 5}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        state = {}

        # First check — ops=5, no stall
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 0)
        self.assertEqual(result.data['status'], 'RUNNING')

        # Second check — same file, ops still 5 → stale=1
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 1)

        # Third check — stale=2, still RUNNING
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 2)
        self.assertEqual(result.data['status'], 'RUNNING')

        # Fourth check — stale=3 → STALLED
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 3)
        self.assertEqual(result.data['status'], 'STALLED')
        self.assertTrue(any(a.type == 'stalled' for a in result.anomalies))

    def test_progress_resets_stall_counter(self):
        self._write_json('timing.json', {'models': {'a': {'count': 5}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        state = {'_progress_last_ops': 5, '_progress_stale': 2}

        # Same ops → stale now 3
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100,
        }, cfg, state)
        self.assertEqual(result.data['status'], 'STALLED')

        # Update file with new OPs → counter resets
        self._write_json('timing.json', {'models': {'a': {'count': 8}}})
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 0)
        self.assertEqual(result.data['status'], 'RUNNING')

    def test_complete_status(self):
        self._write_json('timing.json', {'models': {'a': {'count': 100}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100,
        }, cfg, {})
        self.assertEqual(result.data['status'], 'COMPLETE')
        self.assertTrue(any(a.type == 'complete' for a in result.anomalies))

    def test_custom_state_key_isolation(self):
        self._write_json('timing.json', {'models': {'a': {'count': 10}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        state_a = {}
        state_b = {}
        c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'state_key': '_tracker_a',
        }, cfg, state_a)
        c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'state_key': '_tracker_b',
        }, cfg, state_b)
        self.assertIn('_tracker_a_last_ops', state_a)
        self.assertIn('_tracker_b_last_ops', state_b)
        self.assertNotIn('_tracker_a_last_ops', state_b)


class TestProcessMonitorPeak(unittest.TestCase):
    def test_peak_tracking_stores_in_state(self):
        c = ProcessMonitor()
        state = {}
        c.check({
            'processes': [{'name': 'testproc', 'match': 'nonexistent_process_xyz', 'track_peaks': True}],
        }, {}, state)
        # No matching process means peaks unchanged
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
        # Should work without errors — no peak keys, no system keys
        self.assertIsInstance(result, CheckResult)
        self.assertNotIn('system_cpu_percent', result.metrics)


if __name__ == '__main__':
    unittest.main()
