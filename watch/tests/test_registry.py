"""Tests for components.registry — discovery, enabled filtering, registration."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.registry import (
    ComponentRegistry,
    create_registry,
    discover_builtin,
    discover_yaml,
    discover_project,
)
from components.base import Component, CheckResult


class FakeComponent(Component):
    name = 'fake'
    description = 'fake component'

    def check(self, comp_cfg, global_cfg, state):
        return CheckResult(metrics={'ok': 1})


class FakeComponent2(Component):
    name = 'fake2'
    description = 'fake component 2'

    def check(self, comp_cfg, global_cfg, state):
        return CheckResult()


class TestComponentRegistry(unittest.TestCase):
    def test_register_and_get(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        self.assertIsNotNone(reg.get('fake'))
        self.assertIsNone(reg.get('nonexistent'))

    def test_enabled_returns_registered(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        enabled = reg.enabled()
        self.assertEqual(len(enabled), 1)
        self.assertEqual(enabled[0].name, 'fake')

    def test_enabled_respects_yaml_flag_disabled(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        reg._configs['fake'] = {'enabled': False}
        enabled = reg.enabled()
        self.assertEqual(len(enabled), 0)

    def test_enabled_respects_yaml_flag_enabled(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        reg._configs['fake'] = {'enabled': True}
        enabled = reg.enabled()
        self.assertEqual(len(enabled), 1)

    def test_enabled_defaults_true_no_config(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        enabled = reg.enabled()
        self.assertEqual(len(enabled), 1)

    def test_get_config_returns_stored(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent(), {'endpoints': [{'url': 'http://x'}]})
        self.assertEqual(reg.get_config('fake'), {'endpoints': [{'url': 'http://x'}]})

    def test_get_config_returns_empty_for_unknown(self):
        reg = ComponentRegistry()
        self.assertEqual(reg.get_config('nonexistent'), {})

    def test_register_merges_remedies(self):
        class Remedied(FakeComponent):
            def remedies(self):
                return {'high_cpu': []}

        reg = ComponentRegistry()
        reg.register(Remedied())
        self.assertIn('high_cpu', reg._remedies)

    def test_register_merges_actions(self):
        from components.base import Action

        class ActionComp(FakeComponent):
            def actions(self):
                return {'restart': Action(description='restart it')}

        reg = ComponentRegistry()
        reg.register(ActionComp())
        self.assertIn('restart', reg._actions)

    def test_multiple_components_registration_order(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        reg.register(FakeComponent2())
        names = [c.name for c in reg.enabled()]
        self.assertEqual(names, ['fake', 'fake2'])


class TestDiscoverBuiltin(unittest.TestCase):
    def test_discovers_all_builtin_components(self):
        reg = ComponentRegistry()
        discover_builtin(reg)
        names = {c.name for c in reg.enabled()}
        self.assertIn('disk_usage', names)
        self.assertIn('git_version', names)
        self.assertIn('http_health', names)
        self.assertIn('process_monitor', names)
        self.assertIn('shell_probe', names)

    def test_all_builtins_default_enabled(self):
        reg = ComponentRegistry()
        discover_builtin(reg)
        self.assertEqual(len(reg.enabled()), 8)


class TestDiscoverYaml(unittest.TestCase):
    def test_enables_config_for_registered_component(self):
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        discover_yaml(reg, {'components': {'fake': {'enabled': True, 'key': 'val'}}})
        self.assertEqual(reg.get_config('fake'), {'enabled': True, 'key': 'val'})

    def test_enabled_false_disables_builtin(self):
        # `enabled: false` must actually disable the component — the config is
        # kept so registry.enabled() can see the flag (built-ins with NO config
        # entry still default to enabled).
        reg = ComponentRegistry()
        reg.register(FakeComponent())
        discover_yaml(reg, {'components': {'fake': {'enabled': False}}})
        self.assertEqual(reg.get_config('fake'), {'enabled': False})
        self.assertEqual([c.name for c in reg.enabled()], [])


class TestDiscoverProject(unittest.TestCase):
    def test_loads_custom_component_from_project_dir(self):
        with tempfile.TemporaryDirectory() as d:
            comp_dir = Path(d) / '.claude' / 'watch' / 'components'
            comp_dir.mkdir(parents=True)
            (comp_dir / 'custom_check.py').write_text("""
from components.base import Component, CheckResult

class CustomCheck(Component):
    name = 'custom_check'
    description = 'a custom check'

    def check(self, comp_cfg, global_cfg, state):
        return CheckResult(metrics={'custom': 42})
""", encoding='utf-8')
            reg = ComponentRegistry()
            discover_project(reg, Path(d))
            comp = reg.get('custom_check')
            self.assertIsNotNone(comp)
            result = comp.check({}, {}, {})
            self.assertEqual(result.metrics['custom'], 42)


class TestCreateRegistry(unittest.TestCase):
    def test_creates_registry_with_builtins(self):
        with tempfile.TemporaryDirectory() as d:
            reg = create_registry({}, Path(d))
            self.assertGreaterEqual(len(reg.enabled()), 5)

    def test_global_actions_from_config(self):
        with tempfile.TemporaryDirectory() as d:
            reg = create_registry({
                'actions': {
                    'custom_cmd': {
                        'description': 'run something',
                        'command': 'echo hello',
                        'timeout': 10,
                    },
                },
            }, Path(d))
            action = reg.get_action('custom_cmd')
            self.assertIsNotNone(action)
            self.assertEqual(action.command, 'echo hello')
            self.assertEqual(action.timeout, 10)

    def test_config_remedies_override_component_default(self):
        with tempfile.TemporaryDirectory() as d:
            reg = create_registry({
                'remedies': {
                    'new_version_available': [
                        {'action': 'deploy'},
                        {'action': 'build_frontend'},
                        {'action': 'restart_all'},
                    ],
                },
            }, Path(d))
            steps = reg.get_remedies('new_version_available')
            self.assertEqual([s.action for s in steps],
                             ['deploy', 'build_frontend', 'restart_all'])

    def test_config_remedies_accept_string_shorthand(self):
        with tempfile.TemporaryDirectory() as d:
            reg = create_registry({
                'remedies': {'high_cpu': ['restart_backend']},
            }, Path(d))
            steps = reg.get_remedies('high_cpu')
            self.assertEqual([s.action for s in steps], ['restart_backend'])


if __name__ == '__main__':
    unittest.main()
