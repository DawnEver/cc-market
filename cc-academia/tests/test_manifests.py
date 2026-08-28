"""Plugin manifests must agree with pyproject, and the marketplaces must list us.

cc-academia ships as one plugin inside the cc-market marketplace, so four files
carry facts about it: this plugin's two host manifests, and the marketplace's two.
`scripts/release.py` writes the versions; this test is the guard that stops a
hand-edit from shipping a split-brain release.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MARKET = ROOT.parent

PLUGIN_MANIFESTS = {
    "claude": ROOT / ".claude-plugin" / "plugin.json",
    "codex": ROOT / ".codex-plugin" / "plugin.json",
}
MARKETPLACES = {
    "claude": MARKET / ".claude-plugin" / "marketplace.json",
    "codex": MARKET / ".agents" / "plugins" / "marketplace.json",
}


def _authoritative_version() -> str:
    """cc-market's pre-push hook bumps plugin.json, so that file leads."""
    return json.loads((PLUGIN_MANIFESTS["claude"]).read_text(encoding="utf-8"))["version"]


def _pyproject() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("host", sorted(PLUGIN_MANIFESTS))
def test_both_host_manifests_carry_the_same_version(host: str) -> None:
    assert _load(PLUGIN_MANIFESTS[host])["version"] == _authoritative_version()


def test_pyproject_derives_its_version_rather_than_stating_one() -> None:
    """A literal version here would be one commit behind after every push."""
    project = _pyproject()
    assert "version" not in project["project"]
    assert "version" in project["project"]["dynamic"]
    assert project["tool"]["hatch"]["version"]["path"] == ".claude-plugin/plugin.json"


def test_the_runtime_reports_the_manifest_version() -> None:
    from academia import __version__

    assert __version__ == _authoritative_version()


@pytest.mark.parametrize("host", sorted(PLUGIN_MANIFESTS))
def test_plugin_name_is_stable(host: str) -> None:
    assert _load(PLUGIN_MANIFESTS[host])["name"] == "cc-academia"


def test_version_is_semver() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", _authoritative_version())


def test_both_hosts_describe_the_same_plugin() -> None:
    """Drift between the two descriptions confuses whoever installs it."""
    assert (
        _load(PLUGIN_MANIFESTS["claude"])["description"]
        == _load(PLUGIN_MANIFESTS["codex"])["description"]
    )


@pytest.mark.skipif(
    not MARKETPLACES["claude"].exists(), reason="running outside the cc-market checkout"
)
@pytest.mark.parametrize("host", sorted(MARKETPLACES))
def test_marketplace_lists_the_plugin_exactly_once(host: str) -> None:
    entries = [p for p in _load(MARKETPLACES[host])["plugins"] if p["name"] == "cc-academia"]
    assert len(entries) == 1


@pytest.mark.skipif(
    not MARKETPLACES["claude"].exists(), reason="running outside the cc-market checkout"
)
def test_marketplace_sources_point_at_this_directory() -> None:
    claude = next(
        p for p in _load(MARKETPLACES["claude"])["plugins"] if p["name"] == "cc-academia"
    )
    codex = next(
        p for p in _load(MARKETPLACES["codex"])["plugins"] if p["name"] == "cc-academia"
    )
    assert claude["source"] == "./cc-academia"
    assert codex["source"] == {"source": "local", "path": "./cc-academia"}
    assert (MARKET / "cc-academia").is_dir()
