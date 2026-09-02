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
import sys
from pathlib import Path

ENV_CONFIG_DIR = "ACADEMIA_CONFIG_DIR"
ENV_LENS_DIR = "ACADEMIA_LENS_DIR"
ENV_DATA_ROOT = "ACADEMIA_DATA_ROOT"
ENV_DB = "ACADEMIA_DB"

#: One directory name for everything this plugin keeps on local disk.
APP_DIRNAME = "cc-academia"
ENV_FACTS_DIR = "ACADEMIA_FACTS_DIR"
ENV_DEVICE = "ACADEMIA_DEVICE"
ENV_FACTS_SYNC = "ACADEMIA_FACTS_SYNC"

#: Folder name for the portable facts, under ACADEMIA_FACTS_DIR or the home
#: directory. Never chosen for the operator: see facts_sync_enabled.
FACTS_DIRNAME = "cc-academia-facts"
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


def local_state_dir() -> Path:
    """The platform's own directory for application state that never syncs.

    Every one of these is excluded from cloud sync by the sync clients
    themselves — ``LOCALAPPDATA`` is the Windows convention precisely because
    OneDrive leaves it alone — which is what the store needs and what a path
    under ``Documents`` cannot promise.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", "").strip()
        return (Path(base) if base else Path.home() / "AppData" / "Local") / APP_DIRNAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIRNAME
    base = os.environ.get("XDG_DATA_HOME", "").strip()
    return (Path(base) if base else Path.home() / ".local" / "share") / APP_DIRNAME


def database_path() -> Path:
    """The accumulating store.

    Deliberately *not* under the data root, and never under a folder a person
    would think to sync: SQLite in WAL mode is corrupted by a file-level syncer.
    It also carries no institution's folder name — a plugin that hardcodes one
    developer's directory layout works on exactly one machine.

    ``ACADEMIA_DB`` moves it anywhere, which is how an existing store is kept
    where it already is.
    """
    explicit = _env_path(ENV_DB)
    if explicit is not None:
        return explicit
    return local_state_dir() / "academia.db"


def facts_dir() -> Path:
    """Where the portable, syncable facts are kept.

    Unlike the database this is safe to sync: line-oriented text, one directory
    per device, so two machines never write the same file and a conflict is a
    visible diff rather than a corrupted page.

    A shared location is never guessed at. These files hold real people's
    addresses and employment, and discovering a cloud folder and quietly writing
    them there is a decision about someone else's personal data.

    ``ACADEMIA_FACTS_DIR`` names the folder outright. Otherwise, once the
    operator has turned export on, the facts go beside the research data they
    describe — under the data root, which is already whatever that person chose
    to sync. That way one flag is the whole configuration and no machine's
    directory layout is written down anywhere. With export off they stay in the
    home directory and do not travel.
    """
    explicit = _env_path(ENV_FACTS_DIR)
    if explicit is not None:
        return explicit
    if facts_sync_enabled():
        root = find_data_root()
        if root is not None:
            return root / FACTS_DIRNAME
    return Path.home() / FACTS_DIRNAME


def export_facts_dir() -> Path | None:
    """Where an export may write, or ``None`` when there is nowhere it belongs.

    ``facts_dir`` always answers with a path because the facts have to rest
    somewhere; the home directory is that resting place while export is off.
    Publishing is a different question. ``ACADEMIA_FACTS_SYNC`` lives in a shell
    profile, so every process started there inherits it, including ones running
    somewhere the data root cannot be found — a test run, a script in a
    temporary directory. Answering "home" for those wrote their people into the
    operator's own facts folder and merged them back on the next run.

    So: an explicit folder, or one beside the research data, or nothing.
    """
    if (explicit := _env_path(ENV_FACTS_DIR)) is not None:
        return explicit
    if not facts_sync_enabled():
        return None
    root = find_data_root()
    return root / FACTS_DIRNAME if root is not None else None


def device_id() -> str:
    """A short, stable name for this machine, used as its facts subdirectory."""
    import platform
    import re

    raw = os.environ.get(ENV_DEVICE, "").strip() or platform.node() or "unknown-device"
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return slug or "unknown-device"


def facts_sync_enabled() -> bool:
    """Off unless the operator turns it on.

    These files hold real people's addresses and employment. Publishing them to
    a cloud folder is a decision about someone else's personal data, and a
    default that does it silently is the wrong one however convenient. Set
    ``ACADEMIA_FACTS_SYNC=1``, and ``ACADEMIA_FACTS_DIR`` to say where.
    """
    return os.environ.get(ENV_FACTS_SYNC, "").strip().lower() in {"1", "true", "on", "yes"}


def contact_email() -> str:
    """Contact address for API polite pools (OpenAlex, Crossref, ORCID)."""
    return os.environ.get(ENV_CONTACT, "").strip()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
