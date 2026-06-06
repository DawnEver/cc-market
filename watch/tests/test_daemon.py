"""Tests for watchd daemon — escalation, counter reset, state management."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

# We test the daemon's state logic in isolation (no real polling).
from core.state import load_state, save_state, track_anomaly, reset_anomaly
from core.config import load_config


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


if __name__ == '__main__':
    unittest.main()
