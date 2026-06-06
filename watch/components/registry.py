"""Component discovery and registration.

Three sources, merged in priority order:
  1. Built-in components (components/ directory)
  2. YAML-declared config (components: section in watch.yaml)
  3. Project custom components (.claude/watch/components/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from components.base import Action, Component, RemedyStep

_COMPONENT_DIR = Path(__file__).resolve().parent


class ComponentRegistry:
    def __init__(self) -> None:
        self._components: dict[str, Component] = {}
        self._configs: dict[str, dict] = {}
        self._remedies: dict[str, list[RemedyStep]] = {}
        self._actions: dict[str, Action] = {}
        self._order: list[str] = []

    def register(self, comp: Component, comp_cfg: dict | None = None) -> None:
        name = comp.name
        self._components[name] = comp
        self._configs[name] = comp_cfg or {}
        self._order.append(name)

        # Merge remedies — project-custom overrides built-in for same anomaly type
        for atype, steps in comp.remedies().items():
            self._remedies[atype] = steps  # last writer wins

        # Merge actions — project-custom overrides built-in for same action name
        for aname, action in comp.actions().items():
            self._actions[aname] = action

    def get(self, name: str) -> Component | None:
        return self._components.get(name)

    def get_config(self, name: str) -> dict:
        return self._configs.get(name, {})

    def get_remedies(self, anomaly_type: str) -> list[RemedyStep]:
        return self._remedies.get(anomaly_type, [RemedyStep(action='log')])

    def get_action(self, action_name: str) -> Action | None:
        return self._actions.get(action_name)

    def enabled(self) -> list[Component]:
        """Return enabled components in registration order.

        A component is enabled if its YAML config has ``enabled: true`` or
        if it has no YAML config entry (built-ins default to enabled)."""
        result = []
        for n in self._order:
            if n not in self._components:
                continue
            cfg = self._configs.get(n, {})
            if cfg.get('enabled', True):
                result.append(self._components[n])
        return result


def discover_builtin(registry: ComponentRegistry) -> None:
    """Load all built-in components from flat .py files."""
    for f in sorted(_COMPONENT_DIR.glob('*.py')):
        if f.name.startswith('_') or f.name in ('base.py', 'registry.py'):
            continue
        _load_module(f, registry)


def discover_yaml(registry: ComponentRegistry, config: dict) -> None:
    """Register components declared in watch.yaml's 'components' section."""
    comps_cfg = config.get('components', {})
    for name, cfg in comps_cfg.items():
        if isinstance(cfg, dict) and cfg.get('enabled') is True:
            # Built-in component that needs its config
            existing = registry.get(name)
            if existing:
                registry._configs[name] = cfg


def discover_project(registry: ComponentRegistry, project_dir: Path) -> None:
    """Load custom components from .claude/watch/components/ directory."""
    custom_dir = project_dir / '.claude' / 'watch' / 'components'
    if not custom_dir.is_dir():
        return
    for f in sorted(custom_dir.glob('*.py')):
        _load_module(f, registry)


def _load_module(path: Path, registry: ComponentRegistry) -> None:
    """Load a Python module and register any Component subclasses found."""
    name = path.stem
    try:
        spec = importlib.util.spec_from_file_location(f'components.{name}', str(path))
        if spec is None or spec.loader is None:
            return
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f'components.{name}'] = mod
        spec.loader.exec_module(mod)
        for attr in dir(mod):
            obj = getattr(mod, attr)
            if isinstance(obj, type) and issubclass(obj, Component) and obj is not Component:
                comp = obj()
                if comp.name:
                    registry.register(comp)
    except Exception as e:
        print(f'[watch] Failed to load component {path}: {e}', file=sys.stderr)


def create_registry(config: dict, project_dir: Path) -> ComponentRegistry:
    """Build the full component registry for a project."""
    reg = ComponentRegistry()

    # 1. Built-in components
    discover_builtin(reg)

    # 2. Apply YAML config (enables/disables, passes per-component config)
    discover_yaml(reg, config)

    # 3. Project custom components (override built-in)
    discover_project(reg, project_dir)

    # 4. Register global actions from config
    global_actions = config.get('actions', {})
    for aname, adef in global_actions.items():
        if isinstance(adef, dict):
            reg._actions[aname] = Action(**{k: v for k, v in adef.items()
                                            if k in Action.__dataclass_fields__})

    return reg
