"""Tests for trigger-watch.py — AI-only anomaly detection and headless escalation."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT / 'scripts'))

# trigger-watch.py does `import bootstrap; bootstrap.ensure()`, which re-execs the
# process into a managed venv — not appropriate inside a test runner. Stub it out.
if 'bootstrap' not in sys.modules:
    _fake_bootstrap = types.ModuleType('bootstrap')
    setattr(_fake_bootstrap, 'ensure', lambda: None)
    sys.modules['bootstrap'] = _fake_bootstrap

from core.config import load_config  # noqa: E402
from core.log import append_report  # noqa: E402

# trigger-watch.py has a hyphen, so it can't be `import`ed normally.
_spec = importlib.util.spec_from_file_location(
    'trigger_watch', _PLUGIN_ROOT / 'scripts' / 'trigger-watch.py')
assert _spec is not None and _spec.loader is not None
trigger_watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trigger_watch)


class TestReportHasAiOnlyAnomaly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.config = load_config(self.project)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_report_returns_false(self):
        self.assertFalse(trigger_watch._report_has_ai_only_anomaly(self.project, self.config))

    def test_report_without_ai_only_anomaly_returns_false(self):
        append_report({'anomalies': [{'type': 'disk_usage_high', 'severity': 'warning'}]},
                      self.project, log_file=self.config['logging']['log_file'])
        self.assertFalse(trigger_watch._report_has_ai_only_anomaly(self.project, self.config))

    def test_report_with_cron_stale_returns_true(self):
        append_report({'anomalies': [{'type': 'cron_stale', 'severity': 'critical'}]},
                      self.project, log_file=self.config['logging']['log_file'])
        self.assertTrue(trigger_watch._report_has_ai_only_anomaly(self.project, self.config))


class TestPollHeadlessEscalation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.config = load_config(self.project)
        trigger_path = self.project / self.config['watchd']['trigger_file']
        trigger_path.parent.mkdir(parents=True, exist_ok=True)
        trigger_path.write_text('{"reason": "anomalies_detected", "detail": "cron_freshness.cron_stale", "timestamp": "2026-01-01T00:00:00+00:00"}')
        # _poll only acts when mtime changed AND both old/new mtimes are > 0 —
        # pretend the trigger existed before with a slightly older mtime.
        self.last_mtime = trigger_path.stat().st_mtime - 1

    def tearDown(self):
        self.tmp.cleanup()

    def test_disabled_by_default_does_not_call_claude(self):
        append_report({'anomalies': [{'type': 'cron_stale', 'severity': 'critical'}]},
                      self.project, log_file=self.config['logging']['log_file'])
        with patch.object(trigger_watch, '_run_ai_loop', return_value=True) as run_loop, \
             patch.object(trigger_watch, '_run_claude_headless') as run_headless:
            trigger_watch._poll(self.project, self.config, self.last_mtime)
        run_loop.assert_called_once()
        run_headless.assert_not_called()

    def test_enabled_with_lingering_anomaly_calls_claude(self):
        config = load_config(self.project)
        config['watchd']['enable_headless_ai_escalation'] = True
        append_report({'anomalies': [{'type': 'cron_stale', 'severity': 'critical'}]},
                      self.project, log_file=config['logging']['log_file'])
        with patch.object(trigger_watch, '_run_ai_loop', return_value=True), \
             patch.object(trigger_watch, '_run_claude_headless', return_value=True) as run_headless:
            trigger_watch._poll(self.project, config, self.last_mtime)
        run_headless.assert_called_once_with(self.project, False)

    def test_enabled_without_lingering_anomaly_skips_claude(self):
        config = load_config(self.project)
        config['watchd']['enable_headless_ai_escalation'] = True
        append_report({'anomalies': []}, self.project, log_file=config['logging']['log_file'])
        with patch.object(trigger_watch, '_run_ai_loop', return_value=True), \
             patch.object(trigger_watch, '_run_claude_headless') as run_headless:
            trigger_watch._poll(self.project, config, self.last_mtime)
        run_headless.assert_not_called()


class TestRunClaudeHeadless(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_does_not_invoke_subprocess(self):
        with patch('subprocess.run') as run:
            ok = trigger_watch._run_claude_headless(self.project, dry_run=True)
        self.assertTrue(ok)
        run.assert_not_called()

    def test_missing_claude_binary_returns_false(self):
        with patch('subprocess.run', side_effect=FileNotFoundError()):
            ok = trigger_watch._run_claude_headless(self.project, dry_run=False)
        self.assertFalse(ok)


if __name__ == '__main__':
    unittest.main()
