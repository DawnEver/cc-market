"""Tests for core.config — defaults, YAML load, local overrides, env vars."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from core.config import DEFAULTS, _deep_merge, _env_override, load_config


class TestDefaults(unittest.TestCase):
    def test_instance_defaults(self):
        self.assertEqual(DEFAULTS['instance']['name'], 'unknown')
        self.assertEqual(DEFAULTS['instance']['check_interval_normal'], 43200)
        self.assertEqual(DEFAULTS['instance']['check_interval_anomaly'], 1800)

    def test_alerts_defaults(self):
        self.assertFalse(DEFAULTS['alerts']['email']['enabled'])
        self.assertEqual(DEFAULTS['alerts']['email']['subject_prefix'], '[watch]')
        self.assertEqual(DEFAULTS['alerts']['email']['cooldown_minutes'], 10)

    def test_logging_defaults(self):
        self.assertEqual(DEFAULTS['logging']['log_file'], '.claude/watch/logs/health.jsonl')
        self.assertEqual(DEFAULTS['logging']['max_entries'], 10000)

    def test_load_config_no_files_returns_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            c = load_config(d)
            self.assertEqual(c['instance']['name'], 'unknown')
            self.assertFalse(c['alerts']['email']['enabled'])


class TestDeepMerge(unittest.TestCase):
    def test_merge_nested(self):
        base = {'a': {'x': 1, 'y': 2}, 'b': 3}
        _deep_merge(base, {'a': {'y': 99}, 'c': 4})
        self.assertEqual(base['a']['x'], 1)
        self.assertEqual(base['a']['y'], 99)
        self.assertEqual(base['b'], 3)
        self.assertEqual(base['c'], 4)

    def test_merge_overwrites_scalars(self):
        base = {'x': 1}
        _deep_merge(base, {'x': 2})
        self.assertEqual(base['x'], 2)


class TestEnvOverride(unittest.TestCase):
    def setUp(self):
        self._saved = {k: v for k, v in os.environ.items() if k.startswith('WATCH_')}
        for k in self._saved:
            del os.environ[k]

    def tearDown(self):
        for k in list(os.environ):
            if k.startswith('WATCH_') and k not in self._saved:
                del os.environ[k]
        os.environ.update(self._saved)

    def test_env_override_simple_key(self):
        os.environ['WATCH_INSTANCE_NAME'] = 'env-server'
        c = _env_override({'instance': {'name': 'default'}})
        self.assertEqual(c['instance']['name'], 'env-server')

    def test_env_override_nested_key(self):
        os.environ['WATCH_ALERTS_EMAIL_TO'] = 'ops@test.com'
        c = _env_override({'alerts': {'email': {'to': ''}}})
        self.assertEqual(c['alerts']['email']['to'], 'ops@test.com')


class TestLocalConfig(unittest.TestCase):
    """Split config: config.yaml (tracked) + config.local.yaml (gitignored)."""

    def test_local_overrides_main(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d) / '.claude' / 'watch'
            wd.mkdir(parents=True)
            _write_yaml(wd / 'config.yaml', {
                'instance': {'name': 'main-server'},
                'thresholds': [{'name': 'cpu', 'critical': 95}],
            })
            _write_yaml(wd / 'config.local.yaml', {
                'alerts': {
                    'email': {'enabled': True, 'from': 'Admin<admin@corp.com>', 'to': 'ops@corp.com'},
                },
            })
            c = load_config(d)
            self.assertEqual(c['instance']['name'], 'main-server')
            self.assertEqual(c['alerts']['email']['from'], 'Admin<admin@corp.com>')
            self.assertEqual(c['alerts']['email']['to'], 'ops@corp.com')
            self.assertTrue(c['thresholds'][0]['critical'], 95)

    def test_local_only_no_main(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d) / '.claude' / 'watch'
            wd.mkdir(parents=True)
            _write_yaml(wd / 'config.local.yaml', {
                'alerts': {'email': {'to': 'no-config@test.com'}},
            })
            c = load_config(d)
            self.assertEqual(c['alerts']['email']['to'], 'no-config@test.com')
            self.assertEqual(c['instance']['name'], 'unknown')

    def test_env_overrides_local(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d) / '.claude' / 'watch'
            wd.mkdir(parents=True)
            _write_yaml(wd / 'config.local.yaml', {
                'alerts': {'email': {'to': 'local@test.com'}},
            })
            os.environ['WATCH_ALERTS_EMAIL_TO'] = 'env@test.com'
            try:
                c = load_config(d)
                self.assertEqual(c['alerts']['email']['to'], 'env@test.com')
            finally:
                del os.environ['WATCH_ALERTS_EMAIL_TO']


def _write_yaml(path: Path, data: dict) -> None:
    import yaml
    path.write_text(yaml.dump(data), encoding='utf-8')


if __name__ == '__main__':
    unittest.main()
