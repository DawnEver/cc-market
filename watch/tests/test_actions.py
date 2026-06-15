"""Tests for the action executor — managed-service and composition forms."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.base import Action
from components.registry import ComponentRegistry
import core.actions as actions


class TestManagedService(unittest.TestCase):
    def setUp(self):
        self._calls: list[tuple[str, list[str]]] = []

        def fake_run_script(script, args, cwd, timeout):
            self._calls.append((script, list(args)))
            return 0, 'ok', ''

        self._orig = actions._run_script
        actions._run_script = fake_run_script
        self._slept: list[float] = []
        self._orig_sleep = actions.time.sleep
        actions.time.sleep = lambda s: self._slept.append(s)

    def tearDown(self):
        actions._run_script = self._orig
        actions.time.sleep = self._orig_sleep

    def test_kill_port_then_start(self):
        a = Action(kill_port=7001, start_cmd='python -m app',
                   start_dir='../deploy', start_log='.claude/watch/logs/x.log', wait=2)
        ok = actions._execute_action(a, Path(tempfile.gettempdir()))
        self.assertTrue(ok)
        self.assertEqual(self._calls[0][0], 'kill-server.py')
        self.assertIn('--port', self._calls[0][1])
        self.assertIn('7001', self._calls[0][1])
        self.assertEqual(self._calls[1][0], 'start-server.py')
        self.assertIn('--cmd', self._calls[1][1])
        self.assertIn('python -m app', self._calls[1][1])
        self.assertEqual(self._slept, [2])

    def test_multiple_kill_ports(self):
        a = Action(kill_port=[7000, 7001])
        ok = actions._execute_action(a, Path(tempfile.gettempdir()))
        self.assertTrue(ok)
        ports = [c[1][-1] for c in self._calls if c[0] == 'kill-server.py']
        self.assertEqual(ports, ['7000', '7001'])

    def test_start_failure_returns_false(self):
        def failing(script, args, cwd, timeout):
            return (1, '', 'boom') if script == 'start-server.py' else (0, '', '')
        actions._run_script = failing
        a = Action(kill_port=7001, start_cmd='python -m app')
        self.assertFalse(actions._execute_action(a, Path(tempfile.gettempdir())))

    def _started_project_dir(self) -> Path:
        """The --project-dir start-server.py was launched with (the resolved cwd)."""
        call = next(c for c in self._calls if c[0] == 'start-server.py')
        return Path(call[1][call[1].index('--project-dir') + 1])

    def test_start_dir_env_overrides_start_dir(self):
        # start_dir_env names an env var holding an absolute cwd (the deploy gate
        # exports a dynamic staging path) — it wins over the static start_dir.
        import os
        staging = Path(tempfile.gettempdir()) / 'wdg-staging-xyz'
        os.environ['WATCH_TEST_STAGING'] = str(staging)
        try:
            a = Action(start_cmd='python -m app', start_dir='../deploy',
                       start_dir_env='WATCH_TEST_STAGING')
            self.assertTrue(actions._execute_action(a, Path(tempfile.gettempdir())))
        finally:
            os.environ.pop('WATCH_TEST_STAGING', None)
        self.assertEqual(self._started_project_dir(), staging.resolve())

    def test_start_dir_env_falls_back_to_start_dir_when_unset(self):
        import os
        os.environ.pop('WATCH_TEST_STAGING_MISSING', None)
        proj = Path(tempfile.gettempdir())
        a = Action(start_cmd='python -m app', start_dir='../deploy',
                   start_dir_env='WATCH_TEST_STAGING_MISSING')
        self.assertTrue(actions._execute_action(a, proj))
        self.assertEqual(self._started_project_dir(), (proj / '../deploy').resolve())


class TestSetupAndVerify(unittest.TestCase):
    def setUp(self):
        self._calls: list[tuple[str, list[str]]] = []
        self._orig = (actions._run_script, actions.time.sleep,
                      actions.run_command, actions._port_listening)
        actions._run_script = lambda s, a, c, t: (self._calls.append((s, list(a))), (0, 'ok', ''))[1]
        actions.time.sleep = lambda s: None
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)

    def tearDown(self):
        (actions._run_script, actions.time.sleep,
         actions.run_command, actions._port_listening) = self._orig
        self._tmp.cleanup()

    def test_setup_cmd_runs_once_then_skips(self):
        runs: list[str] = []
        actions.run_command = lambda cmd, **kw: (runs.append(cmd), (0, '', ''))[1]
        a = Action(start_cmd='python -m app', start_dir='svc', setup_cmd='yarn install')
        self.assertTrue(actions._execute_action(a, self.proj))
        self.assertTrue(actions._execute_action(a, self.proj))  # marker present now
        self.assertEqual(runs, ['yarn install'])  # ran exactly once
        self.assertTrue((self.proj / 'svc' / '.watch-setup-done').exists())

    def test_setup_failure_aborts_start(self):
        actions.run_command = lambda cmd, **kw: (1, '', 'no network')
        a = Action(start_cmd='python -m app', start_dir='svc', setup_cmd='yarn install')
        self.assertFalse(actions._execute_action(a, self.proj))
        self.assertFalse(any(s == 'start-server.py' for s, _ in self._calls))

    def test_verify_port_failure_fails_action(self):
        actions._port_listening = lambda port, timeout: False
        a = Action(start_cmd='python -m app', verify_port=7001, verify_timeout=1)
        self.assertFalse(actions._execute_action(a, self.proj))

    def test_verify_port_success(self):
        actions._port_listening = lambda port, timeout: True
        a = Action(start_cmd='python -m app', verify_port=7001, verify_timeout=1)
        self.assertTrue(actions._execute_action(a, self.proj))


class TestComposition(unittest.TestCase):
    def test_steps_run_subactions_in_order(self):
        reg = ComponentRegistry()
        order: list[str] = []
        reg._actions['a'] = Action(command='noop_a')
        reg._actions['b'] = Action(command='noop_b')
        reg._actions['both'] = Action(steps=['a', 'b'])

        orig = actions.run_command
        actions.run_command = lambda cmd, **kw: (order.append(cmd), (0, '', ''))[1]
        try:
            ok = actions._execute_action(reg._actions['both'],
                                         Path(tempfile.gettempdir()), reg)
        finally:
            actions.run_command = orig
        self.assertTrue(ok)
        self.assertEqual(order, ['noop_a', 'noop_b'])

    def test_missing_step_action_fails(self):
        reg = ComponentRegistry()
        reg._actions['both'] = Action(steps=['nope'])
        self.assertFalse(actions._execute_action(
            reg._actions['both'], Path(tempfile.gettempdir()), reg))


if __name__ == '__main__':
    unittest.main()
