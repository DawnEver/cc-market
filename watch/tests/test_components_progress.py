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

from components.progress.progress_tracker import ProgressTracker


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
        # Completion is a terminal success signal, NOT an anomaly.
        self.assertEqual(len(result.anomalies), 0)
        self.assertTrue(any(c['type'] == 'complete' for c in result.completions))
        self.assertEqual(result.completions[0]['ops_done'], 100)
        self.assertEqual(result.completions[0]['total_ops'], 100)

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

    def test_output_dir_resolution_default(self):
        # active-run.json at the default path resolves ${OUTPUT_DIR}.
        self._write_json('.claude/watch/active-run.json',
                         {'output_dir': str(self.proj / 'out'), 'total_ops': 5})
        self._write_json('out/timing.json', {'models': {'a': {'count': 5}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': '${OUTPUT_DIR}/timing.json', 'count_path': 'models',
            'total_ops_path': '.claude/watch/active-run.json',
        }, cfg, {})
        self.assertEqual(result.metrics['ops_done'], 5)
        self.assertEqual(result.data['status'], 'COMPLETE')

    def test_output_dir_resolution_custom_active_run_file(self):
        # A custom active_run_file is honored (lets two configs coexist).
        self._write_json('runs/task-a.json',
                         {'output_dir': str(self.proj / 'outA'), 'total_ops': 3})
        self._write_json('outA/timing.json', {'models': {'a': {'count': 1}}})
        c = ProgressTracker()
        cfg = {'_project_dir': str(self.proj)}
        result = c.check({
            'progress_file': '${OUTPUT_DIR}/timing.json', 'count_path': 'models',
            'active_run_file': 'runs/task-a.json',
            'total_ops_path': 'runs/task-a.json',
        }, cfg, {})
        self.assertEqual(result.metrics['ops_done'], 1)
        self.assertEqual(result.data['status'], 'RUNNING')


class TestLoopCompleteStatus(unittest.TestCase):
    """End-to-end: a completed task reports `complete`, not `degraded`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self.tmp.name)
        (self.proj / 'out').mkdir(parents=True)
        (self.proj / '.claude' / 'watch').mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, rel, data):
        p = self.proj / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data), encoding='utf-8')

    def test_complete_status_end_to_end(self):
        from datetime import datetime, timezone

        import yaml
        from core import loop

        self._write('.claude/watch/active-run.json',
                    {'output_dir': str(self.proj / 'out'), 'total_ops': 10})
        self._write('out/timing.json', {'models': {'a': {'count': 10}}})
        # Built-ins default to enabled. Keep the two daemon-liveness checks quiet
        # (a fresh daemon.jsonl for the loop meta-check, a fresh heartbeat.json
        # for the watchd_heartbeat component) so no warning masks `complete`.
        now = datetime.now(timezone.utc).isoformat()
        dj = self.proj / '.claude' / 'watch' / 'logs' / 'daemon.jsonl'
        dj.parent.mkdir(parents=True, exist_ok=True)
        dj.write_text(json.dumps({'ts': now}) + '\n', encoding='utf-8')
        hb = self.proj / '.claude' / 'watch' / 'state' / 'heartbeat.json'
        hb.parent.mkdir(parents=True, exist_ok=True)
        hb.write_text(json.dumps({'ts': now, 'pid': 1}), encoding='utf-8')
        cfg = {
            'instance': {'name': 'test'},
            'components': {
                'progress_tracker': {
                    'enabled': True,
                    'progress_file': '${OUTPUT_DIR}/timing.json',
                    'count_path': 'models',
                    'combine': 'sum',
                    'total_ops_path': '.claude/watch/active-run.json',
                },
            },
        }
        (self.proj / '.claude' / 'watch' / 'config.yaml').write_text(
            yaml.safe_dump(cfg), encoding='utf-8')

        report = loop.run(str(self.proj))
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(len(report['anomalies']), 0)
        self.assertTrue(report['completions'])
        self.assertTrue(report['summary'].startswith('COMPLETE'))


if __name__ == '__main__':
    unittest.main()
