"""Tests for trigger-emit.py — the Monitor feed for the in-session bridge."""
from __future__ import annotations

import importlib.util
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent

# trigger-emit.py has a hyphen, so it can't be `import`ed normally. It is pure stdlib
# (no bootstrap), so loading it does not re-exec.
_spec = importlib.util.spec_from_file_location(
    'trigger_emit', _PLUGIN_ROOT / 'scripts' / 'trigger-emit.py')
assert _spec is not None and _spec.loader is not None
trigger_emit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trigger_emit)


class TestTriggerEmit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.trigger = self.project / '.claude' / 'watch' / 'trigger.json'
        self.trigger.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_mtime_missing_is_zero(self):
        self.assertEqual(trigger_emit._mtime(self.trigger), 0.0)

    def test_emits_on_change(self):
        # Pre-existing trigger so the first snapshot is non-zero (no emit on appearance).
        self.trigger.write_text('{"reason": "old", "detail": "x"}', encoding='utf-8')
        # time.sleep is patched to a no-op; the file is rewritten before the poll reads it.
        self.trigger.write_text(
            '{"reason": "anomalies_detected", "detail": "endpoint_unreachable:2x"}',
            encoding='utf-8')
        # Bump mtime to guarantee a detectable change even on coarse-resolution clocks.
        st = self.trigger.stat()
        os.utime(self.trigger, (st.st_atime + 5, st.st_mtime + 5))

        buf = io.StringIO()
        with patch.object(trigger_emit.time, 'sleep', lambda _x: None), \
             redirect_stdout(buf):
            # last mtime is the OLD value; first poll sees the bumped one and emits, then --once exits.
            with patch.object(trigger_emit, '_mtime',
                              side_effect=[1000.0, 2000.0]):
                trigger_emit.main(['--project-dir', str(self.project), '--once'])
        out = buf.getvalue()
        self.assertIn('ANOMALY trigger: anomalies_detected', out)
        self.assertIn('endpoint_unreachable:2x', out)

    def test_no_emit_on_first_appearance(self):
        # last == 0 (no file at start); file appears → must NOT emit (avoids stale trigger).
        buf = io.StringIO()
        with patch.object(trigger_emit.time, 'sleep', lambda _x: None), \
             redirect_stdout(buf):
            with patch.object(trigger_emit, '_mtime', side_effect=[0.0, 2000.0]):
                # No --once: would loop forever, so stop after the first poll via StopIteration.
                with self.assertRaises(StopIteration):
                    trigger_emit.main(['--project-dir', str(self.project)])
        self.assertEqual(buf.getvalue(), '')


    def _run_once(self, payload_json, extra_args=None):
        """Drive one poll over a changed trigger and capture stdout."""
        self.trigger.write_text('{"reason": "old", "detail": "x"}', encoding='utf-8')
        self.trigger.write_text(payload_json, encoding='utf-8')
        buf = io.StringIO()
        argv = ['--project-dir', str(self.project), '--once'] + (extra_args or [])
        with patch.object(trigger_emit.time, 'sleep', lambda _x: None), \
             redirect_stdout(buf):
            try:
                with patch.object(trigger_emit, '_mtime', side_effect=[1000.0, 2000.0]):
                    trigger_emit.main(argv)
            except StopIteration:
                pass  # --once never reached because the event was filtered out
        return buf.getvalue()

    def test_ignore_ai_only_skips_ai_only_trigger(self):
        out = self._run_once(
            '{"reason": "anomalies_detected", "detail": "cron", '
            '"anomaly_types": ["cron_stale"], "ai_only": true}',
            extra_args=['--ignore-ai-only'])
        self.assertEqual(out, '')

    def test_ignore_ai_only_still_emits_actionable(self):
        out = self._run_once(
            '{"reason": "anomalies_detected", "detail": "down", '
            '"anomaly_types": ["endpoint_unreachable"], "ai_only": false}',
            extra_args=['--ignore-ai-only'])
        self.assertIn('ANOMALY trigger: anomalies_detected', out)

    def test_without_flag_emits_ai_only(self):
        out = self._run_once(
            '{"reason": "anomalies_detected", "detail": "cron", '
            '"anomaly_types": ["cron_stale"], "ai_only": true}')
        self.assertIn('ANOMALY trigger: anomalies_detected', out)


if __name__ == '__main__':
    unittest.main()
