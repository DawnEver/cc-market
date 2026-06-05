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
    'actions': {},
    'alerts': {
        'email': {'enabled': False, 'host': 'localhost', 'port': 25,
                  'to': '', 'from': 'watch@localhost', 'subject_prefix': '[watch]',
                  'cooldown_minutes': 10},
        'webhook': {'enabled': False, 'url': '', 'cooldown_minutes': 5},
    },
    'logging': {
        'log_file': '.claude/health-log.jsonl',
        'max_entries': 10000,
        'state_file': '.claude/watch-state.json',
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


def load_config(project_dir: str | Path, config_path: str | None = None) -> dict:
    project = Path(project_dir)
    cfg_file = project / (config_path or '.claude/watch.yaml')

    config = dict(DEFAULTS)
    if cfg_file.exists():
        try:
            import yaml
            user = yaml.safe_load(cfg_file.read_text(encoding='utf-8')) or {}
        except ImportError:
            import json
            user = json.loads(cfg_file.read_text(encoding='utf-8'))
        _deep_merge(config, user)

    _env_override(config)
    return config
