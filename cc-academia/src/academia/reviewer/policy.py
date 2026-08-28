"""Policy loading: plugin defaults, journal overlay, user override.

Three layers, resolved deepest-last, so a journal file only has to state what it
changes and a user only has to state what they change on top of that. No layer
forks the others.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from academia.core import paths
from academia.core.errors import UsageError


def _load_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursive overlay. Scalars replace; tables merge key by key."""
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


@dataclass(frozen=True)
class Policy:
    """A resolved policy plus the provenance of where it came from."""

    data: dict[str, Any]
    sources: list[str] = field(default_factory=list)
    journal: str = ""

    # -- windows ---------------------------------------------------------
    @property
    def coauthor_years(self) -> int:
        return int(self.data["windows"]["coauthor_years"])

    @property
    def historic_collaboration_papers(self) -> int:
        return int(self.data["windows"]["historic_collaboration_papers"])

    @property
    def shared_institution_overlap_years(self) -> int:
        return int(self.data["windows"]["shared_institution_overlap_years"])

    # -- rules -----------------------------------------------------------
    @property
    def block_rules(self) -> set[str]:
        return set(self.data["rules"]["block"])

    @property
    def review_rules(self) -> set[str]:
        return set(self.data["rules"]["review"])

    def status_for(self, rule: str) -> str:
        if rule in self.block_rules:
            return "BLOCK"
        if rule in self.review_rules:
            return "REVIEW"
        return "CLEAR"

    # -- thresholds ------------------------------------------------------
    @property
    def heavy_citation_threshold(self) -> int:
        return int(self.data["thresholds"]["heavily_cited_by_manuscript"])

    # -- geography -------------------------------------------------------
    @property
    def geo_mode(self) -> str:
        return str(self.data["geo"]["mode"])

    @property
    def geo_bonus(self) -> float:
        return float(self.data["geo"]["bonus"])

    # -- seniority -------------------------------------------------------
    @property
    def min_academic_age(self) -> int:
        return int(self.data["seniority"]["min_academic_age"])

    @property
    def max_academic_age(self) -> int:
        return int(self.data["seniority"]["max_academic_age"])

    # -- scoring ---------------------------------------------------------
    @property
    def weights(self) -> dict[str, float]:
        return {k: float(v) for k, v in self.data["scoring"].items()}

    def fingerprint(self) -> str:
        """Stable hash of the effective policy, recorded with every run."""
        import hashlib
        import json

        payload = json.dumps(self.data, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def load_policy(journal: str = "", *, exclusion_list: list[str] | None = None) -> Policy:
    """Resolve the effective policy for a journal.

    ``journal`` is a slug matching a file in ``configs/journals/``. An unknown
    slug is an error rather than a silent fallback: quietly reviewing a TIE
    submission under default windows is exactly the kind of thing that should
    stop the pipeline.
    """
    base_path = paths.config_file("coi.toml")
    if not base_path.exists():
        raise UsageError(f"COI policy not found: {base_path}")

    data = _load_toml(base_path)
    sources = [str(base_path)]

    if journal:
        journal_path = paths.config_file("journals", f"{journal.lower()}.toml")
        if not journal_path.exists():
            available = sorted(p.stem for p in (paths.default_config_dir() / "journals").glob("*.toml"))
            raise UsageError(
                f"unknown journal '{journal}'. Available: {', '.join(available) or 'none'}"
            )
        overlay = _load_toml(journal_path)
        data = _merge(data, overlay)
        sources.append(str(journal_path))

    if exclusion_list:
        data = _merge(data, {"exclusions": {"names": list(exclusion_list)}})

    return Policy(data=data, sources=sources, journal=journal)


def excluded_names(policy: Policy) -> set[str]:
    from academia.core.text import normalize_name

    names = (policy.data.get("exclusions") or {}).get("names") or []
    return {normalize_name(n) for n in names if n}
