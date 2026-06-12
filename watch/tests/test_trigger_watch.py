"""Tests for trigger-watch.py — trigger polling and AI loop dispatch."""
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

# trigger-watch.py has a hyphen, so it can't be `import`ed normally.
_spec = importlib.util.spec_from_file_location(
    'trigger_watch', _PLUGIN_ROOT / 'scripts' / 'daemon' / 'trigger-watch.py')
assert _spec is not None and _spec.loader is not None
trigger_watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trigger_watch)


class TestPoll(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.config = load_config(self.project)
        trigger_path = self.project / self.config['watchd']['trigger_file']
        trigger_path.parent.mkdir(parents=True, exist_ok=True)
        trigger_path.write_text(
            '{"reason": "anomalies_detected", "detail": "git_version.deploy_failed", '
            '"timestamp": "2026-01-01T00:00:00+00:00"}')
        # _poll only acts when mtime changed AND both old/new mtimes are > 0 —
        # pretend the trigger existed before with a slightly older mtime.
        self.last_mtime = trigger_path.stat().st_mtime - 1

    def tearDown(self):
        self.tmp.cleanup()

    def test_poll_runs_ai_loop_on_change(self):
        with patch.object(trigger_watch, '_run_ai_loop', return_value=True) as run_loop:
            trigger_watch._poll(self.project, self.config, self.last_mtime)
        run_loop.assert_called_once()

    def test_poll_acks_on_success(self):
        with patch.object(trigger_watch, '_run_ai_loop', return_value=True):
            trigger_watch._poll(self.project, self.config, self.last_mtime)
        ack = self.project / '.claude' / 'watch' / 'state' / 'trigger_ack.json'
        self.assertTrue(ack.exists())


if __name__ == '__main__':
    unittest.main()
