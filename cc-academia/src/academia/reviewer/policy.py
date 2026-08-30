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


OFF = "off"
PREFER = "prefer"
REQUIRE = "require"
_MODES = (OFF, PREFER, REQUIRE)


@dataclass(frozen=True)
class Constraint:
    """One tunable eligibility rule and how strictly it is applied.

    Every constraint an editor can set carries its own mode, so a journal can
    demand a third-year doctoral floor while merely preferring recent activity.
    ``require`` excludes rather than penalises: blending an eligibility failure
    into a score is how someone who does not meet the policy climbs back onto a
    shortlist on expertise alone.
    """

    name: str
    mode: str
    settings: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.mode not in _MODES:
            raise UsageError(
                f"{self.name}: unknown mode '{self.mode}'. Use one of {', '.join(_MODES)}"
            )

    @property
    def off(self) -> bool:
        return self.mode == OFF

    @property
    def excluding(self) -> bool:
        return self.mode == REQUIRE

    def get(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)

    def int_(self, key: str, default: int = 0) -> int:
        return int(self.settings.get(key, default))

    def float_(self, key: str, default: float = 0.0) -> float:
        return float(self.settings.get(key, default))


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

    @property
    def doctoral(self) -> Constraint:
        """The floor a doctoral candidate has to clear to be invitable."""
        return self._constraint("doctoral_year", self.data["seniority"]["doctoral"])

    # -- activity --------------------------------------------------------
    @property
    def activity(self) -> Constraint:
        return self._constraint("recent_activity", self.data["activity"])

    @property
    def invitation_activity(self) -> Constraint:
        return self._constraint("invitation_response", self.data["activity"]["invitations"])

    @property
    def veteran(self) -> Constraint:
        return self._constraint("unresponsive_veteran", self.data["activity"]["veteran"])

    def _constraint(self, name: str, table: dict[str, Any]) -> Constraint:
        return Constraint(name=name, mode=str(table["mode"]), settings=dict(table))

    # -- scoring ---------------------------------------------------------
    @property
    def weights(self) -> dict[str, float]:
        return {k: float(v) for k, v in self.data["scoring"].items()}

    # -- retrieval -------------------------------------------------------
    def retrieval(self, key: str, default: Any = None) -> Any:
        """A retrieval mechanic, falling back to the caller's module default."""
        return (self.data.get("retrieval") or {}).get(key, default)

    def retrieval_int(self, key: str, default: int) -> int:
        return int(self.retrieval(key, default))

    def retrieval_float(self, key: str, default: float) -> float:
        return float(self.retrieval(key, default))

    @property
    def email_confidence(self) -> dict[str, float]:
        values = (self.data.get("retrieval") or {}).get("email_confidence") or {}
        return {str(key): float(value) for key, value in values.items()}

    @property
    def email_precedence(self) -> tuple[str, ...]:
        values = self.retrieval("email_precedence", [])
        return tuple(str(value) for value in values)

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

    policy = Policy(data=data, sources=sources, journal=journal)
    # Build every constraint now so a typo in a mode stops the run here, rather
    # than at report time with intake, search and enrichment already spent.
    _ = (policy.activity, policy.doctoral, policy.invitation_activity, policy.veteran)
    return policy


def excluded_names(policy: Policy) -> set[str]:
    from academia.core.text import normalize_name

    names = (policy.data.get("exclusions") or {}).get("names") or []
    return {normalize_name(n) for n in names if n}
