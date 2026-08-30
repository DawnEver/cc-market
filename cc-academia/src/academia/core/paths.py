"""Filesystem locations.

Three roots, three lifetimes (see PLAN §1):

* **plugin root** — code and default config; changes when the plugin is updated.
* **config/lens override dirs** — personal customisation; change when the user changes.
* **data root / database** — research output; changes with the work itself.

The immutable plugin root is derived from this module's location. User-owned
configuration and data locations remain explicit environment overrides.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_CONFIG_DIR = "ACADEMIA_CONFIG_DIR"
ENV_LENS_DIR = "ACADEMIA_LENS_DIR"
ENV_DATA_ROOT = "ACADEMIA_DATA_ROOT"
ENV_DB = "ACADEMIA_DB"
ENV_FACTS_DIR = "ACADEMIA_FACTS_DIR"
ENV_DEVICE = "ACADEMIA_DEVICE"
ENV_FACTS_SYNC = "ACADEMIA_FACTS_SYNC"
ENV_CONTACT = "ACADEMIA_CONTACT"


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser() if raw else None


def plugin_root() -> Path:
    """Root of the installed plugin or source checkout containing this code."""
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


#: Every workflow uses ``ongoing`` for work in progress. Archive names are
#: workflow-specific: literature-review uses the singular ``archive`` while the
#: other established workflows retain ``archived``.
ONGOING = "ongoing"
ARCHIVE_DIRS = {"literature-review": "archive"}
DEFAULT_ARCHIVE_DIR = "archived"

WORKFLOWS = ("literature-review", "manuscript-review", "reviewer-discovery")

DEFAULT_DATA_DIRNAME = "cc-academia-data"

#: Files that mark a real project rather than a directory that happens to share
#: the name. Committed, so they survive a fresh clone where `ongoing/` does not.
PROJECT_MARKERS = ("AGENTS.md", "README.md")

#: Legacy name, kept only so the CLI can say what to rename rather than looking
#: at an empty directory and reporting no work.
LEGACY_DIRS = {"literature-review": "workspaces"}


def find_data_root(start: Path | None = None) -> Path | None:
    """Walk up from ``start`` for a directory holding the workflow projects.

    Discovery rather than configuration: the alternative is an absolute path in a
    settings file, and these settings are committed to a repository that syncs
    across machines and platforms, where an absolute path is correct on exactly
    one of them.

    A bare directory name is too weak a marker — a stray ``literature-review``
    folder left in ``AppData/Local`` by an earlier run was enough to match one.
    ``ongoing/`` is too strict on its own, because it is gitignored and therefore
    absent from a fresh clone. So either counts: a committed project file, or the
    working directory itself.
    """
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        for workflow in WORKFLOWS:
            base = candidate / workflow
            if not base.is_dir():
                continue
            if any((base / marker).exists() for marker in PROJECT_MARKERS):
                return candidate
            if (base / ONGOING).is_dir() or (base / LEGACY_DIRS.get(workflow, ONGOING)).is_dir():
                return candidate
    return None


def data_root() -> Path:
    """Where research data lives.

    Explicit setting first, then discovery from the working directory, then a
    home-directory default for a fresh install with no research tree yet.
    """
    explicit = _env_path(ENV_DATA_ROOT)
    if explicit is not None:
        return explicit
    discovered = find_data_root()
    if discovered is not None:
        return discovered
    return Path.home() / DEFAULT_DATA_DIRNAME


def ongoing_root(workflow: str) -> Path:
    """Where this workflow keeps work in progress."""
    return data_root() / workflow / ONGOING


def archive_root(workflow: str) -> Path:
    """Where this workflow keeps finished work."""
    return data_root() / workflow / ARCHIVE_DIRS.get(workflow, DEFAULT_ARCHIVE_DIR)


def legacy_workspaces_root(workflow: str) -> Path | None:
    """A pre-unification directory that still holds data, if one exists.

    Returned so a command can name the rename instead of silently reporting an
    empty workspace, which looks identical to having done no work.
    """
    legacy = LEGACY_DIRS.get(workflow)
    if legacy is None:
        return None
    path = data_root() / workflow / legacy
    return path if path.is_dir() else None


def database_path() -> Path:
    """The accumulating store.

    Deliberately *not* under the data root: a SQLite file on a syncing folder
    (OneDrive, Dropbox) gets corrupted. Keep it on local disk.
    """
    explicit = _env_path(ENV_DB)
    if explicit is not None:
        return explicit
    return Path.home() / "Documents" / "PEMC" / "cc-academia-data" / "academia.db"


#: Environment variables OneDrive sets for its own roots. Commercial first: a
#: university tenant is where research data belongs, and a machine signed into
#: both would otherwise put it in the personal drive.
_ONEDRIVE_ENV = ("OneDriveCommercial", "OneDriveConsumer", "OneDrive")

#: Where the portable facts live inside whichever synced root is found.
FACTS_DIRNAME = "cc-academia-facts"


def onedrive_root() -> Path | None:
    """The OneDrive folder this machine syncs, if there is one.

    Discovered, never configured: the environment variables are set by the
    OneDrive client itself, and the folder name differs per tenant — "OneDrive -
    The University of Nottingham" on one machine, plain "OneDrive" on another.
    An absolute path in a committed config would be correct on exactly one
    machine, which is the bug this avoids.
    """
    for name in _ONEDRIVE_ENV:
        raw = os.environ.get(name, "").strip()
        if raw and Path(raw).is_dir():
            return Path(raw)
    for candidate in sorted(Path.home().glob("OneDrive*")):
        if candidate.is_dir():
            return candidate
    return None


def facts_dir() -> Path:
    """Where the portable, syncable facts are kept.

    Unlike the database this is safe to sync: line-oriented text, one directory
    per device, so two machines never write the same file and a conflict is a
    visible diff rather than a corrupted page. Falls back to the home directory
    when no synced root exists, which still works — it just does not travel.
    """
    explicit = _env_path(ENV_FACTS_DIR)
    if explicit is not None:
        return explicit
    root = onedrive_root()
    return (root / FACTS_DIRNAME) if root is not None else (Path.home() / FACTS_DIRNAME)


def device_id() -> str:
    """A short, stable name for this machine, used as its facts subdirectory."""
    import platform
    import re

    raw = os.environ.get(ENV_DEVICE, "").strip() or platform.node() or "unknown-device"
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return slug or "unknown-device"


def facts_sync_enabled() -> bool:
    """Sync unless the environment turns it off."""
    return os.environ.get(ENV_FACTS_SYNC, "").strip().lower() not in {"0", "false", "off", "no"}


def contact_email() -> str:
    """Contact address for API polite pools (OpenAlex, Crossref, ORCID)."""
    return os.environ.get(ENV_CONTACT, "").strip()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
