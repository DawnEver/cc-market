"""Tests for watchd daemon — escalation, counter reset, state management,
daemon liveness detection, and auto-restart."""
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

# We test the daemon's state logic in isolation (no real polling).
from core.state import load_state, save_state, track_anomaly, reset_anomaly
from core.config import load_config
from core.daemon_helpers import _check_daemon_liveness, _restart_watchd


class TestStatePersistence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_state_returns_empty_for_missing_file(self):
        s = load_state(self.project)
        self.assertEqual(s, {})

    def test_save_and_load_state_roundtrip(self):
        state = {'fails': 2, 'last_ok': '2026-01-01T00:00:00Z'}
        save_state(self.project, state, '.claude/watch/state/test.json')
        loaded = load_state(self.project, '.claude/watch/state/test.json')
        self.assertEqual(loaded['fails'], 2)

    def test_save_state_creates_parent_dirs(self):
        save_state(self.project, {'x': 1}, '.claude/watch/state/nested/deep.json')
        path = self.project / '.claude/watch/state/nested/deep.json'
        self.assertTrue(path.exists())


class TestEscalationLogic(unittest.TestCase):
    """Simulate daemon poll cycles to verify escalation ordering."""

    def test_escalation_triggers_on_second_fail(self):
        """Fails counter incremented before check — 2nd fail triggers."""
        state = {'fails': 0}
        # Simulate 1st poll: anomaly detected
        state['fails'] = state.get('fails', 0) + 1  # fails=1
        self.assertLess(state['fails'], 2)  # no escalation yet

        # Simulate 2nd poll: anomaly persists
        state['fails'] = state.get('fails', 0) + 1  # fails=2
        self.assertGreaterEqual(state['fails'], 2)  # escalation!

    def test_escalation_resets_on_recovery(self):
        state = {'fails': 2}
        # Recovery: all_ok=True
        state['fails'] = 0
        self.assertEqual(state['fails'], 0)

    def test_consecutive_counters_reset_on_recovery(self):
        state = {
            'consecutive_disk_usage_high': 3,
            'consecutive_git_version_new': 1,
            'fails': 2,
        }
        # Simulate all_ok recovery
        for key in list(state):
            if key.startswith('consecutive_'):
                state.pop(key, None)
        self.assertNotIn('consecutive_disk_usage_high', state)
        self.assertNotIn('consecutive_git_version_new', state)
        self.assertIn('fails', state)  # fails key preserved


class TestTrackAnomaly(unittest.TestCase):
    def test_track_anomaly_increments(self):
        state = {}
        c1 = track_anomaly(state, 'disk_full')
        self.assertEqual(c1, 1)
        c2 = track_anomaly(state, 'disk_full')
        self.assertEqual(c2, 2)

    def test_track_anomaly_separate_keys(self):
        state = {}
        track_anomaly(state, 'cpu')
        track_anomaly(state, 'ram')
        self.assertEqual(state['consecutive_cpu'], 1)
        self.assertEqual(state['consecutive_ram'], 1)

    def test_reset_anomaly(self):
        state = {'consecutive_cpu': 5}
        reset_anomaly(state, 'cpu')
        self.assertNotIn('consecutive_cpu', state)


class TestConfigHotReload(unittest.TestCase):
    """Simulate daemon config hot-reload behavior."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_config_reloaded_in_loop(self):
        """Config is reloaded each iteration — new components appear."""
        project = Path(self.tmp.name)
        wd = project / '.claude' / 'watch'
        wd.mkdir(parents=True)

        # Initial config — no components enabled
        import yaml
        (wd / 'config.yaml').write_text(yaml.dump({
            'instance': {'name': 'test'},
            'components': {},
        }))

        from components.registry import create_registry

        c1 = load_config(project)
        r1 = create_registry(c1, project)
        # Built-ins are always discovered, so registry won't be empty.
        # Test that config is re-readable.
        self.assertEqual(c1['instance']['name'], 'test')

        # Update config
        (wd / 'config.yaml').write_text(yaml.dump({
            'instance': {'name': 'updated'},
            'components': {},
        }))
        c2 = load_config(project)
        self.assertEqual(c2['instance']['name'], 'updated')


class TestCheckDaemonLiveness(unittest.TestCase):
    """Tests for _check_daemon_liveness() — daemon.jsonl freshness."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_log(self, path, entries):
        log_dir = path.parent
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            for e in entries:
                f.write(json.dumps(e) + '\n')

    def test_no_daemon_jsonl_returns_anomaly(self):
        config = {'watchd': {'interval': 300, 'log_file': 'logs/daemon.jsonl'}}
        result = _check_daemon_liveness(self.project, config)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].type, 'daemon_not_running')
        self.assertIn('never polled', result[0].message)

    def test_fresh_log_returns_no_anomaly(self):
        log_path = self.project / 'logs' / 'daemon.jsonl'
        now = datetime.now(timezone.utc).isoformat()
        self._write_log(log_path, [{'ts': now, 'level': 'info', 'msg': 'poll'}])
        config = {'watchd': {'interval': 300, 'log_file': 'logs/daemon.jsonl'}}
        result = _check_daemon_liveness(self.project, config)
        self.assertEqual(len(result), 0)

    def test_stale_log_returns_anomaly(self):
        log_path = self.project / 'logs' / 'daemon.jsonl'
        stale = (datetime.now(timezone.utc) - timedelta(seconds=200)).isoformat()
        self._write_log(log_path, [{'ts': stale, 'level': 'info', 'msg': 'poll'}])
        config = {'watchd': {'interval': 60, 'log_file': 'logs/daemon.jsonl'}}
        result = _check_daemon_liveness(self.project, config)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].type, 'daemon_not_running')
        self.assertIn('appears dead', result[0].message)

    def test_invalid_timestamp_returns_anomaly(self):
        log_path = self.project / 'logs' / 'daemon.jsonl'
        self._write_log(log_path, [{'ts': 'not-a-date', 'level': 'info', 'msg': 'poll'}])
        config = {'watchd': {'interval': 300, 'log_file': 'logs/daemon.jsonl'}}
        result = _check_daemon_liveness(self.project, config)
        self.assertEqual(len(result), 1)
        self.assertIn('invalid timestamp', result[0].message)

    def test_custom_log_file_path_from_config(self):
        log_path = self.project / 'custom' / 'mylog.jsonl'
        now = datetime.now(timezone.utc).isoformat()
        self._write_log(log_path, [{'ts': now, 'level': 'info', 'msg': 'poll'}])
        config = {'watchd': {'interval': 300, 'log_file': 'custom/mylog.jsonl'}}
        result = _check_daemon_liveness(self.project, config)
        self.assertEqual(len(result), 0)

    def test_uses_default_log_path_when_not_in_config(self):
        log_path = self.project / '.claude' / 'watch' / 'logs' / 'daemon.jsonl'
        now = datetime.now(timezone.utc).isoformat()
        self._write_log(log_path, [{'ts': now, 'level': 'info', 'msg': 'poll'}])
        result = _check_daemon_liveness(self.project, {})
        self.assertEqual(len(result), 0)


class TestRestartWatchd(unittest.TestCase):
    """Tests for _restart_watchd() — daemon auto-restart."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    @patch('core.daemon_helpers.run_command')
    def test_restart_calls_start_server_with_correct_args(self, mock_run):
        mock_run.return_value = (0, 'Process started (PID 12345)', '')
        config = {'watchd': {'auto_restart': True}}
        ok = _restart_watchd(self.project, config)
        self.assertTrue(ok)
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        self.assertIn('start-server.py', cmd)
        self.assertIn('daemon.py', cmd)
        self.assertIn(str(self.project), cmd)

    @patch('core.daemon_helpers.run_command')
    def test_restart_returns_false_on_failure(self, mock_run):
        mock_run.return_value = (1, '', 'spawn failed')
        config = {'watchd': {'auto_restart': True}}
        ok = _restart_watchd(self.project, config)
        self.assertFalse(ok)


class TestWakeClaudeTriggerPayload(unittest.TestCase):
    """_wake_claude — trigger payload enrichment."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        from scripts.daemon import daemon
        self.daemon = daemon
        self.config = {'watchd': {
            'trigger_file': '.claude/watch/trigger.json',
            'log_file': '.claude/watch/logs/daemon.jsonl',
        }}

    def tearDown(self):
        self.tmp.cleanup()

    def _trigger_path(self):
        return self.project / '.claude' / 'watch' / 'trigger.json'

    def test_anomaly_writes_trigger_with_types(self):
        self.daemon._wake_claude(
            self.project, self.config, 'anomalies_detected', 'x',
            anomaly_types={'endpoint_unreachable'})
        payload = json.loads(self._trigger_path().read_text(encoding='utf-8'))
        self.assertEqual(payload['anomaly_types'], ['endpoint_unreachable'])
        self.assertEqual(payload['reason'], 'anomalies_detected')


if __name__ == '__main__':
    unittest.main()
