"""Minimal config loader — no dependency on the main watch plugin."""

from __future__ import annotations

from pathlib import Path


def load_config(project_dir: str | Path) -> dict:
    project = Path(project_dir)
    cfg = _defaults()

    yaml_file = project / '.claude' / 'watch.yaml'
    if yaml_file.exists():
        try:
            import yaml
            user = yaml.safe_load(yaml_file.read_text(encoding='utf-8')) or {}
            _merge(cfg, user)
        except ImportError:
            pass

    # Extract derived fields
    repos = _extract_repos(cfg)
    health_url = 'http://127.0.0.1:8000/health/'
    eps = cfg.get('components', {}).get('http_health', {}).get('endpoints', [])
    if eps:
        health_url = eps[0].get('url', 'http://127.0.0.1:8000') + eps[0].get('health_path', '/health/')

    return {
        'project_dir': str(project),
        'instance': cfg.get('instance', {}).get('name', project.name),
        'interval': cfg.get('instance', {}).get('check_interval_normal', 43200),
        'repos': repos,
        'health_url': health_url,
        'email_to': cfg.get('alerts', {}).get('email', {}).get('to', ''),
        'email_prefix': cfg.get('alerts', {}).get('email', {}).get('subject_prefix', '[watch]'),
    }


def _defaults() -> dict:
    return {
        'instance': {'name': 'unknown', 'check_interval_normal': 43200},
        'components': {},
        'alerts': {},
    }


def _merge(base: dict, override: dict) -> None:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v


def _extract_repos(cfg: dict) -> list[dict]:
    vt = cfg.get('components', {}).get('git_version', {})
    repos = vt.get('repositories', [])
    return repos if repos else [{'name': 'main', 'path': '.'}]
