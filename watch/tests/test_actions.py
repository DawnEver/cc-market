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
