"""Lightweight data loading and validation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import rtoml


def load_data(path: Path) -> Any:
    """Load TOML, YAML (legacy), or JSON data from path."""
    with path.open("r", encoding="utf-8") as f:
        if path.suffix.lower() in {".toml"}:
            return rtoml.load(f)
        if path.suffix.lower() in {".yaml", ".yml"}:
            import yaml
            return yaml.safe_load(f)
        return json.load(f)


def dump_data(data: Any, path: Path) -> None:
    """Write data as TOML or JSON based on extension."""
    with path.open("w", encoding="utf-8") as f:
        if path.suffix.lower() in {".toml"}:
            rtoml.dump(data, f)
        elif path.suffix.lower() in {".json"}:
            json.dump(data, f, indent=2, ensure_ascii=True)
        else:
            rtoml.dump(data, f)


def require_keys(data: dict, *keys: str) -> list[str]:
    """Check that *data* has all *keys*. Returns list of missing key names."""
    return [k for k in keys if k not in data]
