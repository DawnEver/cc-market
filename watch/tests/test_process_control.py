"""Tests for process-control helpers in start-server.py / kill-server.py.

These scripts have hyphenated filenames (not importable by name), so we load
them via importlib from the scripts/ directory.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / 'scripts' / 'helpers'


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


kill_server = _load('watch_kill_server', 'kill-server.py')
start_server = _load('watch_start_server', 'start-server.py')


class TestNetstatParsing(unittest.TestCase):
    def test_listening_match_exact_port(self):
        out = (
            '  Proto  Local Address      Foreign Address    State        PID\n'
            '  TCP    0.0.0.0:7001       0.0.0.0:0          LISTENING    4242\n'
        )
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), ['4242']
        )

    def test_inconsistent_spacing(self):
        out = 'TCP\t127.0.0.1:7001\t0.0.0.0:0\tLISTENING\t  9001'
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), ['9001']
        )

    def test_ignores_time_wait_and_established(self):
        out = (
            '  TCP    0.0.0.0:7001   1.2.3.4:55  TIME_WAIT    111\n'
            '  TCP    0.0.0.0:7001   1.2.3.4:55  ESTABLISHED  222\n'
            '  TCP    0.0.0.0:7001   0.0.0.0:0   LISTENING    333\n'
        )
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), ['333']
        )

    def test_no_substring_port_match(self):
        # :70010 must not match port 7001.
        out = '  TCP    0.0.0.0:70010   0.0.0.0:0   LISTENING    999\n'
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), []
        )

    def test_ipv6_listening(self):
        out = '  TCP    [::]:7001   [::]:0   LISTENING   555\n'
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), ['555']
        )

    def test_dedup_pids(self):
        out = (
            '  TCP    0.0.0.0:7001   0.0.0.0:0   LISTENING   42\n'
            '  TCP    [::]:7001      [::]:0      LISTENING   42\n'
        )
        self.assertEqual(
            kill_server.parse_listening_pids_win(out, '7001'), ['42']
        )

    def test_empty_output(self):
        self.assertEqual(kill_server.parse_listening_pids_win('', '7001'), [])


class TestKillByPortRetry(unittest.TestCase):
    def setUp(self):
        self._orig_pids = kill_server._listening_pids
        self._orig_kill = kill_server._kill_pid
        self._orig_sleep = kill_server.time.sleep
        self._killed: list[str] = []
        kill_server._kill_pid = lambda pid: self._killed.append(pid)
        kill_server.time.sleep = lambda s: None

    def tearDown(self):
        kill_server._listening_pids = self._orig_pids
        kill_server._kill_pid = self._orig_kill
        kill_server.time.sleep = self._orig_sleep

    def test_no_process_returns_true(self):
        kill_server._listening_pids = lambda port: []
        self.assertTrue(kill_server.kill_by_port('7001'))
        self.assertEqual(self._killed, [])

    def test_freed_after_first_kill(self):
        seq = [['100'], []]
        kill_server._listening_pids = lambda port: seq.pop(0)
        self.assertTrue(kill_server.kill_by_port('7001'))
        self.assertEqual(self._killed, ['100'])

    def test_still_bound_after_all_attempts(self):
        kill_server._listening_pids = lambda port: ['200']
        self.assertFalse(kill_server.kill_by_port('7001'))
        # one kill per attempt
        self.assertEqual(self._killed, ['200', '200', '200'])


class TestStartupProbe(unittest.TestCase):
    def test_is_alive(self):
        class FakeProc:
            def __init__(self, code):
                self._code = code
                self.returncode = code

            def poll(self):
                return self._code

        self.assertTrue(start_server._is_alive(FakeProc(None)))
        self.assertFalse(start_server._is_alive(FakeProc(1)))

    def test_win_startupinfo_only_on_win32(self):
        if sys.platform == 'win32':
            si = start_server._build_win_startupinfo(redirecting=True)
            self.assertIsNotNone(si)
            self.assertTrue(si.dwFlags & start_server.subprocess.STARTF_USESTDHANDLES)
        else:
            self.assertIsNone(start_server._build_win_startupinfo(redirecting=True))


if __name__ == '__main__':
    unittest.main()
