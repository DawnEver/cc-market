"""Tests for core.pidfile — cross-platform single-instance guard."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))

from core import pidfile  # noqa: E402

NAME = 'test.pid'


class TestPidfile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_acquire_writes_own_pid(self):
        self.assertTrue(pidfile.acquire(self.project, NAME))
        self.assertEqual(pidfile.read(self.project, NAME), os.getpid())

    def test_reacquire_by_same_process_succeeds(self):
        self.assertTrue(pidfile.acquire(self.project, NAME))
        self.assertTrue(pidfile.acquire(self.project, NAME))

    def test_live_other_owner_blocks_acquire(self):
        # Pretend a different, live process owns the file.
        pidfile.path(self.project, NAME).write_text('999999', encoding='utf-8')
        with patch.object(pidfile, 'pid_alive', return_value=True):
            self.assertFalse(pidfile.acquire(self.project, NAME))

    def test_stale_owner_is_taken_over(self):
        pidfile.path(self.project, NAME).write_text('999999', encoding='utf-8')
        with patch.object(pidfile, 'pid_alive', return_value=False):
            self.assertTrue(pidfile.acquire(self.project, NAME))
        self.assertEqual(pidfile.read(self.project, NAME), os.getpid())

    def test_release_only_removes_own_pidfile(self):
        pidfile.acquire(self.project, NAME)
        pidfile.release(self.project, NAME)
        self.assertIsNone(pidfile.read(self.project, NAME))

    def test_release_leaves_foreign_pidfile(self):
        pidfile.path(self.project, NAME).write_text('999999', encoding='utf-8')
        pidfile.release(self.project, NAME)  # not ours — must stay
        self.assertEqual(pidfile.read(self.project, NAME), 999999)

    def test_read_missing_returns_none(self):
        self.assertIsNone(pidfile.read(self.project, NAME))

    def test_pid_alive_self(self):
        self.assertTrue(pidfile.pid_alive(os.getpid()))

    def test_terminate_no_owner_returns_false(self):
        self.assertFalse(pidfile.terminate(self.project, NAME))


if __name__ == '__main__':
    unittest.main()
