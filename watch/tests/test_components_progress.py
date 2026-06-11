"""Tests for ProgressTracker component."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.progress_tracker import ProgressTracker


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
        self.assertEqual(result.metrics['ops_done'], 5)

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

        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 0)
        self.assertEqual(result.data['status'], 'RUNNING')

        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 1)

        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100, 'stale_threshold': 3,
        }, cfg, state)
        self.assertEqual(state['_progress_stale'], 2)
        self.assertEqual(result.data['status'], 'RUNNING')

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

        result = c.check({
            'progress_file': 'timing.json', 'count_path': 'models',
            'total_ops': 100,
        }, cfg, state)
        self.assertEqual(result.data['status'], 'STALLED')

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


if __name__ == '__main__':
    unittest.main()
