"""Research brief operations — validate, approve, and gate on scope."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from academia.litreview.schema import dump_data, load_data, require_keys

SCOPE_FIELDS = (
    "original_request",
    "research_objective",
    "constraints",
    "concepts",
)


def load_brief(path: Path) -> dict[str, Any]:
    """Load a research brief, rejecting non-object YAML documents."""
    data = load_data(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML object")
    return data


def scope_payload(brief: dict[str, Any]) -> dict[str, Any]:
    """Return only user-reviewable scope fields used by the approval digest."""
    payload = {field: deepcopy(brief.get(field)) for field in SCOPE_FIELDS}
    criteria = brief.get("criteria")
    criteria = criteria if isinstance(criteria, dict) else {}
    payload["inclusion_criteria"] = deepcopy(
        brief.get("inclusion_criteria", criteria.get("include"))
    )
    payload["exclusion_criteria"] = deepcopy(
        brief.get("exclusion_criteria", criteria.get("exclude"))
    )
    return payload


def scope_sha256(brief: dict[str, Any]) -> str:
    """Hash research scope deterministically, independent of YAML formatting."""
    canonical = json.dumps(
        scope_payload(brief),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


BRIEF_REQUIRED = [
    "original_request", "research_objective", "constraints", "concepts",
]


def validate_brief(brief: dict[str, Any]) -> list[str]:
    """Validate brief required fields and business invariants."""
    errors = require_keys(brief, *BRIEF_REQUIRED)
    if not isinstance(brief.get("constraints"), dict):
        errors.append("constraints must be a dict with year_from, year_to, content_types")

    concepts = brief.get("concepts")
    if isinstance(concepts, list):
        ids = [c.get("concept_id") for c in concepts if isinstance(c, dict)]
        duplicates = sorted({i for i in ids if i and ids.count(i) > 1})
        if duplicates:
            errors.append(f"concepts: duplicate concept_id values: {duplicates}")

    constraints = brief.get("constraints") or {}
    yf, yt = constraints.get("year_from"), constraints.get("year_to")
    if isinstance(yf, int) and isinstance(yt, int) and yf > yt:
        errors.append("constraints: year_from must not exceed year_to")
    return errors


def assert_approved(brief: dict[str, Any]) -> None:
    """Raise when a brief lacks approval or changed after approval."""
    approval = brief.get("approval")
    if not isinstance(approval, dict) or approval.get("approved") is not True:
        raise ValueError("research brief is not approved; run confirm-brief")
    if approval.get("research_scope_sha256") != scope_sha256(brief):
        raise ValueError("research brief changed after approval; run confirm-brief again")


def confirm_brief(path: Path, approved_by: str = "user") -> dict[str, Any]:
    """Validate, approve, and persist a research brief."""
    identity = approved_by.strip()
    if not identity:
        raise ValueError("approved_by must not be empty")
    brief = load_brief(path)
    errors = validate_brief(brief)
    if errors:
        raise ValueError("invalid research brief:\n" + "\n".join(errors))

    brief["approval"] = {
        "approved": True,
        "approved_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "approved_by": identity,
        "research_scope_sha256": scope_sha256(brief),
    }
    errors = validate_brief(brief)
    if errors:
        raise ValueError("invalid confirmed research brief:\n" + "\n".join(errors))

    dump_data(brief, path)
    return brief
