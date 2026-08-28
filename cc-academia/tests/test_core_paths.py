"""Config resolution is a layering relationship: override first, plugin default second."""

from __future__ import annotations

from academia.core import paths


def test_plugin_root_prefers_the_host_injected_variable(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.PLUGIN_ROOT_ENV, str(tmp_path))
    assert paths.plugin_root() == tmp_path


def test_plugin_root_falls_back_to_the_checkout(monkeypatch):
    monkeypatch.delenv(paths.PLUGIN_ROOT_ENV, raising=False)
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


def test_each_workflow_keeps_its_existing_directory_name(tmp_path, monkeypatch):
    """These directories predate the plugin and hold real research data.

    literature-review uses `workspaces/`, the review workflows use `ongoing/`.
    Renaming them to satisfy a uniform scheme would move hundreds of megabytes of
    manuscripts for the tool's convenience.
    """
    monkeypatch.setenv(paths.ENV_DATA_ROOT, str(tmp_path))
    assert paths.workspaces_root("literature-review") == tmp_path / "literature-review" / "workspaces"
    assert paths.workspaces_root("manuscript-review") == tmp_path / "manuscript-review" / "ongoing"
    assert paths.workspaces_root("reviewer-discovery") == tmp_path / "reviewer-discovery" / "ongoing"


def test_an_unmapped_workflow_falls_back_to_its_own_name(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ENV_DATA_ROOT, str(tmp_path))
    assert paths.workspaces_root("something-new") == tmp_path / "something-new"
