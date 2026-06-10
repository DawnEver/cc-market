"""Config loader — YAML parse, defaults, WATCH_* env override."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


DEFAULTS: dict[str, Any] = {
    'instance': {
        'name': 'unknown',
        'check_interval_normal': 43200,    # 12h
        'check_interval_anomaly': 1800,    # 30m
    },
    'components': {},
    'watchd': {
        'interval': 300,
        'fail_threshold': 2,
        'auto_restart': True,
        'log_file': '.claude/watch/logs/daemon.jsonl',
        'state_file': '.claude/watch/state/daemon.json',
        'trigger_file': '.claude/watch/trigger.json',
        'heartbeat_file': '.claude/watch/state/heartbeat.json',
        'enable_headless_ai_escalation': False,
    },
    'actions': {},
    'deploy': {
        'enable_test_gate': False,
        'test_health_url': '',
        'test_health_timeout': 30,
        'test_start_action': '',
        'test_kill_action': '',
        'test_prestart_sleep': 5,
    },
    'alerts': {
        'email': {'enabled': False, 'host': 'localhost', 'port': 25,
                  'to': '', 'from': 'watch@localhost', 'subject_prefix': '[watch]',
                  'cooldown_minutes': 10},
        'webhook': {'enabled': False, 'url': '', 'cooldown_minutes': 5},
    },
    'logging': {
        'log_file': '.claude/watch/logs/health.jsonl',
        'max_entries': 10000,
        'state_file': '.claude/watch/state/monitor.json',
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def _env_override(config: dict, prefix: str = 'WATCH_') -> dict:
    for key, val in os.environ.items():
        if not key.startswith(prefix):
            continue
        path = key[len(prefix):].lower().split('_')
        target = config
        for part in path[:-1]:
            if part not in target or not isinstance(target[part], dict):
                target[part] = {}
            target = target[part]
        try:
            v = float(val)
            if v == int(v) and '.' not in val:
                v = int(v)
        except ValueError:
            v = val
        target[path[-1]] = v
    return config


def _load_yaml_file(path: Path) -> dict:
    """Load YAML (or JSON fallback) from a file. Returns empty dict on failure."""
    if not path.exists():
        return {}
    try:
        import yaml
        return yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    except ImportError:
        import json
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return {}


def load_config(project_dir: str | Path, config_path: str | None = None) -> dict:
    """Load project config with merge priority: env > config.local.yaml > config.yaml > defaults.

    config.yaml       — structural config (tracked in git)
    config.local.yaml — sensitive overrides: email from/to, webhook URLs (gitignored)
    """
    project = Path(project_dir)
    watch_dir = project / '.claude' / 'watch'

    config = dict(DEFAULTS)

    # 1. Main config (version-tracked): instance, components, thresholds, actions, remedies
    main_file = watch_dir / (config_path or 'config.yaml')
    if main_file.exists():
        _deep_merge(config, _load_yaml_file(main_file))

    # 2. Local overrides (gitignored): email from/to, SMTP creds, webhook URLs
    local_file = watch_dir / 'config.local.yaml'
    if local_file.exists():
        _deep_merge(config, _load_yaml_file(local_file))

    # 3. Environment overrides (highest priority)
    _env_override(config)

    # 4. Validate cross-field constraints
    _validate_config(config)

    return config


def _validate_config(config: dict) -> None:
    deploy = config.get('deploy', {})
    if deploy.get('enable_test_gate'):
        missing = []
        for key in ('test_health_url', 'test_start_action', 'test_kill_action'):
            if not deploy.get(key):
                missing.append(key)
        if missing:
            raise ValueError(
                f'deploy.enable_test_gate is True but these required fields are '
                f'missing or empty: {", ".join(missing)}. '
                f'All three must be configured for the test gate to work.'
            )
