"""Config resolution is a layering relationship: override first, plugin default second."""

from __future__ import annotations

from pathlib import Path

from academia.core import paths


def test_plugin_root_is_the_package_checkout():
    assert (paths.plugin_root() / "pyproject.toml").exists()


def test_config_file_uses_override_when_present(tmp_path, monkeypatch):
    override = tmp_path / "cfg"
    (override / "journals").mkdir(parents=True)
    mine = override / "journals" / "tie.yaml"
    mine.write_text("geo_policy: {}", encoding="utf-8")
    monkeypatch.setenv(paths.ENV_CONFIG_DIR, str(override))
    assert paths.config_file("journals", "tie.yaml") == mine


def test_config_file_falls_back_to_plugin_default(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ENV_CONFIG_DIR, str(tmp_path / "empty"))
    resolved = paths.config_file("coi.yaml")
    assert resolved == paths.default_config_dir() / "coi.yaml"


def test_lens_file_returns_none_when_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ENV_LENS_DIR, str(tmp_path))
    assert paths.lens_file("no-such-lens") is None


def test_database_never_defaults_under_the_data_root(monkeypatch):
    """A SQLite file on a syncing folder gets corrupted — keep the two apart."""
    monkeypatch.delenv(paths.ENV_DB, raising=False)
    monkeypatch.setenv(paths.ENV_DATA_ROOT, "C:/Users/x/OneDrive/workspaces")
    assert paths.data_root() not in paths.database_path().parents


def test_every_workflow_uses_the_same_two_directories(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ENV_DATA_ROOT, str(tmp_path))
    for workflow in paths.WORKFLOWS:
        assert paths.ongoing_root(workflow) == tmp_path / workflow / "ongoing"
        expected = "archive" if workflow == "literature-review" else "archived"
        assert paths.archive_root(workflow) == tmp_path / workflow / expected


def test_a_legacy_directory_is_reported_so_it_can_be_renamed(tmp_path, monkeypatch):
    """An empty new directory looks exactly like having done no work."""
    monkeypatch.setenv(paths.ENV_DATA_ROOT, str(tmp_path))
    assert paths.legacy_workspaces_root("literature-review") is None

    (tmp_path / "literature-review" / "workspaces").mkdir(parents=True)
    legacy = paths.legacy_workspaces_root("literature-review")
    assert legacy == tmp_path / "literature-review" / "workspaces"
    assert paths.legacy_workspaces_root("manuscript-review") is None


def test_data_root_is_discovered_by_walking_up(tmp_path, monkeypatch):
    """No absolute path belongs in a settings file that syncs across machines."""
    monkeypatch.delenv(paths.ENV_DATA_ROOT, raising=False)
    root = tmp_path / "agents"
    (root / "literature-review" / "ongoing").mkdir(parents=True)
    nested = root / "literature-review" / "ongoing" / "some-topic" / "search"
    nested.mkdir(parents=True)
    monkeypatch.chdir(nested)
    assert paths.data_root() == root.resolve()


def test_an_explicit_setting_beats_discovery(tmp_path, monkeypatch):
    root = tmp_path / "agents"
    (root / "manuscript-review" / "ongoing").mkdir(parents=True)
    monkeypatch.chdir(root)
    monkeypatch.setenv(paths.ENV_DATA_ROOT, str(tmp_path / "elsewhere"))
    assert paths.data_root() == tmp_path / "elsewhere"


def test_a_fresh_install_falls_back_to_the_home_directory(tmp_path, monkeypatch):
    monkeypatch.delenv(paths.ENV_DATA_ROOT, raising=False)
    monkeypatch.chdir(tmp_path)
    assert paths.data_root().name == paths.DEFAULT_DATA_DIRNAME


def test_a_bare_directory_name_is_not_enough_to_be_a_root(tmp_path, monkeypatch):
    """A stray `literature-review` folder in AppData once matched. It must not."""
    monkeypatch.delenv(paths.ENV_DATA_ROOT, raising=False)
    decoy = tmp_path / "decoy"
    (decoy / "literature-review").mkdir(parents=True)
    monkeypatch.chdir(decoy)
    assert paths.find_data_root() is None


def test_a_fresh_clone_is_still_discoverable(tmp_path, monkeypatch):
    """`ongoing/` is gitignored, so it does not exist until the first run."""
    monkeypatch.delenv(paths.ENV_DATA_ROOT, raising=False)
    root = tmp_path / "agents"
    project = root / "reviewer-discovery"
    project.mkdir(parents=True)
    (project / "AGENTS.md").write_text("data only", encoding="utf-8")
    monkeypatch.chdir(project)
    assert paths.find_data_root() == root.resolve()


def test_discovery_finds_the_root_from_a_sibling_project(tmp_path, monkeypatch):
    """Working in reviewer-discovery must find the same root as literature-review."""
    monkeypatch.delenv(paths.ENV_DATA_ROOT, raising=False)
    root = tmp_path / "agents"
    (root / "literature-review" / "ongoing").mkdir(parents=True)
    (root / "reviewer-discovery").mkdir(parents=True)
    monkeypatch.chdir(root / "reviewer-discovery")
    assert paths.data_root() == root.resolve()


def test_the_store_defaults_to_local_state_not_a_synced_folder(monkeypatch, tmp_path):
    """A hardcoded Documents subfolder works on exactly one person's machine."""
    monkeypatch.delenv(paths.ENV_DB, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))

    path = paths.database_path()

    assert path.name == "academia.db"
    assert paths.APP_DIRNAME in path.parts
    assert "Documents" not in path.parts
    assert "PEMC" not in path.parts
    assert not any("onedrive" in part.lower() for part in path.parts)


def test_an_explicit_store_path_still_wins(monkeypatch, tmp_path):
    """Which is how an existing store is kept exactly where it already is."""
    monkeypatch.setenv(paths.ENV_DB, str(tmp_path / "elsewhere" / "academia.db"))
    assert paths.database_path() == tmp_path / "elsewhere" / "academia.db"


def test_facts_follow_the_data_root_once_export_is_turned_on(monkeypatch, tmp_path):
    """One flag is the whole configuration; the location follows the synced data."""
    root = tmp_path / "agents"
    (root / "reviewer-discovery" / "ongoing").mkdir(parents=True)
    monkeypatch.delenv(paths.ENV_FACTS_DIR, raising=False)
    monkeypatch.chdir(root)

    monkeypatch.setenv(paths.ENV_FACTS_SYNC, "0")
    assert paths.facts_dir() == Path.home() / paths.FACTS_DIRNAME

    monkeypatch.setenv(paths.ENV_FACTS_SYNC, "1")
    assert paths.facts_dir() == root / paths.FACTS_DIRNAME


def test_an_explicit_facts_dir_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv(paths.ENV_FACTS_SYNC, "1")
    monkeypatch.setenv(paths.ENV_FACTS_DIR, str(tmp_path / "elsewhere"))
    assert paths.facts_dir() == tmp_path / "elsewhere"
