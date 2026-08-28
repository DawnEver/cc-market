"""Filesystem locations.

Three roots, three lifetimes (see PLAN §1):

* **plugin root** — code and default config; changes when the plugin is updated.
* **config/lens override dirs** — personal customisation; change when the user changes.
* **data root / database** — research output; changes with the work itself.

Everything is resolved from environment variables so the same code runs from a
Claude plugin cache, a Codex plugin cache, or a plain checkout.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Both Claude Code and Codex inject this; only the root path differs.
PLUGIN_ROOT_ENV = "CLAUDE_PLUGIN_ROOT"

ENV_CONFIG_DIR = "ACADEMIA_CONFIG_DIR"
ENV_LENS_DIR = "ACADEMIA_LENS_DIR"
ENV_DATA_ROOT = "ACADEMIA_DATA_ROOT"
ENV_DB = "ACADEMIA_DB"
ENV_CONTACT = "ACADEMIA_CONTACT"


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser() if raw else None


def plugin_root() -> Path:
    """Root of the installed plugin, or of the source checkout when developing."""
    from_env = _env_path(PLUGIN_ROOT_ENV)
    if from_env is not None:
        return from_env
    # src/academia/core/paths.py -> repo root
    return Path(__file__).resolve().parents[3]


def default_config_dir() -> Path:
    return plugin_root() / "configs"


def config_file(*parts: str) -> Path:
    """Resolve a config file, preferring the user's override directory.

    The override directory holds only the files the user actually customised;
    anything absent falls back to the defaults shipped with the plugin. This is a
    layering relationship, not a fork.
    """
    override = _env_path(ENV_CONFIG_DIR)
    if override is not None:
        candidate = override.joinpath(*parts)
        if candidate.exists():
            return candidate
    return default_config_dir().joinpath(*parts)


def lens_dir() -> Path:
    return _env_path(ENV_LENS_DIR) or (default_config_dir() / "lenses")


def lens_file(lens_id: str) -> Path | None:
    """Locate a domain lens by id, override directory first."""
    for base in (_env_path(ENV_LENS_DIR), default_config_dir() / "lenses"):
        if base is None:
            continue
        candidate = base / f"{lens_id}.toml"
        if candidate.exists():
            return candidate
    return None


def data_root() -> Path:
    """Where workspaces live. Documents (PDFs, reports) — sync-friendly."""
    return _env_path(ENV_DATA_ROOT) or (Path.home() / "cc-academia-workspaces")


#: Where each workflow keeps its workspaces, relative to the data root.
#:
#: Not a uniform ``<data-root>/<workflow>/``: these directories predate the
#: plugin and hold real research data, and the names carry meaning to the person
#: browsing them. Renaming 650MB of manuscripts to satisfy a scheme would be the
#: tool imposing on the work rather than fitting it.
WORKFLOW_DIRS = {
    "literature-review": Path("literature-review") / "workspaces",
    "manuscript-review": Path("manuscript-review") / "ongoing",
    "reviewer-discovery": Path("reviewer-discovery") / "ongoing",
}


def workspaces_root(workflow: str) -> Path:
    """Workspace directory for a workflow.

    Replaces the old ``find_root()``, which walked up the tree hunting for a
    project marker. Shipped as a plugin there is no such tree, so the location is
    a user setting rather than a property of the checkout.
    """
    relative = WORKFLOW_DIRS.get(workflow, Path(workflow))
    return data_root() / relative


def database_path() -> Path:
    """The accumulating store.

    Deliberately *not* under the data root: a SQLite file on a syncing folder
    (OneDrive, Dropbox) gets corrupted. Keep it on local disk.
    """
    explicit = _env_path(ENV_DB)
    if explicit is not None:
        return explicit
    return Path.home() / "Documents" / "PEMC" / "cc-academia-data" / "academia.db"


def contact_email() -> str:
    """Contact address for API polite pools (OpenAlex, Crossref, ORCID)."""
    return os.environ.get(ENV_CONTACT, "").strip()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
