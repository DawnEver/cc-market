"""Query plan evaluation, approval gating, and refinement suggestions."""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import rtoml

from academia.litreview.brief import assert_approved, load_brief, scope_sha256
from academia.litreview.models import Concept
from academia.litreview.schema import load_data, require_keys

ARTIFACT_VERSION = 1
DEFAULT_MIN_TOTAL = 10
DEFAULT_MAX_TOTAL = 1000


# ---------------------------------------------------------------------------
# Query plan hashing and approval gating
# ---------------------------------------------------------------------------


def query_plan_sha256(plan: dict[str, Any]) -> str:
    """Hash enabled queries and all reviewed constraints."""
    queries = plan.get("queries")
    enabled = (
        [q for q in queries if isinstance(q, dict) and q.get("enabled") is True]
        if isinstance(queries, list)
        else queries
    )
    payload = {
        "brief_ref": plan.get("brief_ref"),
        "constraints": plan.get("constraints"),
        "queries": enabled,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _compat_queries_sha256(plan: dict[str, Any]) -> str:
    """Legacy hash for plans confirmed before research briefs were introduced."""
    canonical = json.dumps(
        plan.get("queries"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def require_approved_plan(plan: dict[str, Any], queries_path: Path | None = None) -> None:
    """Raise if the query plan is not approved or changed after approval."""
    approval = plan.get("approval")
    if not isinstance(approval, dict) or approval.get("approved") is not True:
        raise ValueError("query plan is not approved; run confirm-queries")

    actual = approval.get("queries_sha256")
    current = query_plan_sha256(plan)
    if actual != current and not (
        not plan.get("brief_ref") and actual == _compat_queries_sha256(plan)
    ):
        raise ValueError("query plan changed after approval; run confirm-queries again")

    # Cross-validate against the linked research brief when present.
    brief_ref = plan.get("brief_ref")
    if not isinstance(brief_ref, dict):
        return
    if queries_path is None:
        raise ValueError("queries path is required to validate the approved research brief")

    relative = str(brief_ref.get("path") or "research_brief.toml")
    brief_path = (queries_path.resolve().parent / relative).resolve()
    try:
        brief_path.relative_to(queries_path.resolve().parent)
    except ValueError as error:
        raise ValueError(
            "research brief path must stay inside the run directory"
        ) from error
    brief = load_brief(brief_path)
    expected = brief_ref.get("research_scope_sha256")
    current_scope = scope_sha256(brief)
    brief_ok = brief.get("approval", {})
    if (
        brief_ok.get("approved") is not True
        or brief_ok.get("research_scope_sha256") != current_scope
        or expected != current_scope
    ):
        raise ValueError(
            "research brief changed after approval; run confirm-brief and confirm-queries again"
        )


def confirm_queries(run_dir: Path, approved_by: str = "user") -> int:
    """Validate and approve a queries.toml plan against its research brief."""
    queries_path = run_dir / "queries.toml"
    if not queries_path.exists():
        raise FileNotFoundError(f"{queries_path} does not exist")

    data = load_data(queries_path)
    if not isinstance(data, dict):
        raise ValueError(f"{queries_path} must contain a YAML object")

    errors = require_keys(data, "queries")
    if errors:
        raise ValueError(f"invalid queries.toml — missing: {errors}")
    if not isinstance(data.get("queries"), list):
        raise ValueError("queries.toml: 'queries' must be a list")

    brief_ref = data.get("brief_ref")
    if isinstance(brief_ref, dict):
        brief_path = run_dir / str(brief_ref.get("path") or "research_brief.toml")
        brief = load_brief(brief_path)
        assert_approved(brief)
        current_scope = scope_sha256(brief)
        if brief_ref.get("research_scope_sha256") != current_scope:
            raise ValueError("queries do not reference the current approved research brief")

        selected_ids = {
            str(c.get("concept_id"))
            for c in brief.get("concepts", [])
            if isinstance(c, dict) and c.get("selected") is True
        }
        for query in data.get("queries", []):
            if not isinstance(query, dict):
                continue
            unknown = set(query.get("concept_ids", [])) - selected_ids
            if unknown:
                raise ValueError(
                    "query references unselected or unknown concepts: "
                    + ", ".join(sorted(unknown))
                )

    data["approval"] = {
        "approved": True,
        "approved_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "approved_by": approved_by.strip(),
        "queries_sha256": query_plan_sha256(data),
    }
    queries_path.write_text(
        rtoml.dumps(data), encoding="utf-8"
    )
    return 0


# ---------------------------------------------------------------------------
# Query evaluation
# ---------------------------------------------------------------------------


def _norm(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(_norm(v) for v in value)
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def evaluate_queries(
    queries_path: Path,
    probe_results_path: Path,
    out_dir: Path,
    min_total: int = DEFAULT_MIN_TOTAL,
    max_total: int = DEFAULT_MAX_TOTAL,
    samples_path: Path | None = None,
) -> int:
    """Evaluate probe results and write refinement suggestions to *out_dir*."""
    # Load query plan and probe results
    plan = load_data(queries_path)
    query_list = plan.get("queries", [])
    if not isinstance(query_list, list) or not query_list:
        raise ValueError(f"{queries_path} does not contain any queries")

    queries = {
        str(q.get("query_id") or q.get("id") or "").strip(): q
        for q in query_list
        if isinstance(q, dict) and q.get("enabled") is not False
    }
    if not queries:
        raise ValueError(f"{queries_path} does not contain any enabled queries")

    probe_by_id: dict[str, dict[str, Any]] = {}
    with probe_results_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            qid = str(row.get("query_id", "")).strip()
            if qid:
                probe_by_id[qid] = row

    # Optional sample text for refinement suggestions
    samples: dict[str, str] = {}
    if samples_path and samples_path.exists():
        grouped: dict[str, list[str]] = defaultdict(list)
        with samples_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                qid = str(row.get("query_id", "")).strip()
                if qid:
                    grouped[qid].append(
                        _norm([row.get(k, "") for k in ("title", "articleTitle", "abstract", "abstractText")])
                    )
        samples = {qid: " ".join(parts) for qid, parts in grouped.items()}

    # Evaluate each query
    evaluations: list[dict[str, Any]] = []
    for query_id, query in queries.items():
        probe = probe_by_id.get(query_id, {})
        total = int(probe.get("total_count") or 0)
        failure = probe.get("failure_reason") if probe else "missing_probe_result"

        if failure:
            classification = "blocked"
        elif total > max_total:
            classification = "too_broad"
        elif total < min_total:
            classification = "too_narrow"
        else:
            classification = "good"

        evaluations.append({
            "query_id": query_id,
            "purpose": query.get("purpose", probe.get("purpose", "")),
            "classification": classification,
            "total_count": total,
            "eligible_for_full_search": classification not in ("too_broad", "blocked"),
            "add_terms": [],
            "exclude_terms": [],
            "agent_review_required": classification != "good",
            "sample_text": " ".join([
                samples.get(query_id, ""),
                _norm(probe.get("first_titles", [])),
            ]).strip(),
            "failure_reason": failure,
        })

    # Write outputs
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_evaluation_md(out_dir, evaluations, min_total, max_total)
    _write_evaluation_artifact(out_dir, evaluations, min_total, max_total, plan)

    blocked = sum(1 for e in evaluations if not e["eligible_for_full_search"])
    print(f"evaluated={len(evaluations)}; blocked_from_full_search={blocked}")
    return 0


def _write_evaluation_md(
    out_dir: Path, evaluations: list[dict[str, Any]], min_total: int, max_total: int
) -> None:
    lines = [
        "# Query Evaluation", "",
        f"Thresholds: too narrow below {min_total}; too broad above {max_total}.", "",
        "| Query | Purpose | Classification | Total Count | Full Search |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for e in evaluations:
        fs = "yes" if e["eligible_for_full_search"] else "no"
        lines.append(
            f"| {e['query_id']} | {e['purpose']} | {e['classification']} | "
            f"{e['total_count']} | {fs} |"
        )
    lines.extend(["", "## Refinement Suggestions", ""])
    for e in evaluations:
        add = ", ".join(e["add_terms"]) if e["add_terms"] else "(none)"
        exc = ", ".join(e["exclude_terms"]) if e["exclude_terms"] else "(none)"
        lines.extend([f"### {e['query_id']}", "", f"- add_terms: {add}", f"- exclude_terms: {exc}", ""])
    (out_dir / "query_evaluation.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _write_evaluation_artifact(
    out_dir: Path,
    evaluations: list[dict[str, Any]],
    min_total: int,
    max_total: int,
    plan: dict[str, Any],
) -> None:
    artifact = {
        "artifact_version": ARTIFACT_VERSION,
        "queries_sha256": query_plan_sha256(plan),
        "thresholds": {"min_total": min_total, "max_total": max_total},
        "suggestions": evaluations,
    }
    with (out_dir / "query_refinement_suggestions.toml").open("w", encoding="utf-8") as handle:
        rtoml.dump(artifact, handle)


# ---------------------------------------------------------------------------
# Boolean expression construction
#
# Previously a separate module. The two are not duplicates -- one approves and
# evaluates a query plan, the other builds the expressions that plan contains --
# but they are one subject and belong in one file.
# ---------------------------------------------------------------------------


def build_keyword_groups(concepts: list[Concept]) -> dict[str, list[Concept]]:
    """Group concepts by their role: ``must``, ``should``, ``context``, ``evidence``, ``exclude``.

    Only selected concepts are included.  The returned dict maps each role
    name to a (possibly empty) list of concepts.
    """
    groups: dict[str, list[Concept]] = {}
    for concept in concepts:
        if not concept.selected:
            continue
        role = concept.role or "should"
        groups.setdefault(role, []).append(concept)
    return groups


def _concept_terms(concept: Concept) -> list[str]:
    """Collect *term* and *synonyms* into a deduplicated list."""
    terms = [concept.term]
    for syn in (concept.synonyms or []):
        if syn and syn not in terms:
            terms.append(syn)
    return terms


def _quoted(term: str) -> str:
    """Quote a term for exact-phrase matching when it contains whitespace."""
    return f'"{term}"' if " " in term else term


def _or_group(concepts: list[Concept]) -> str:
    """Build an OR-clause from a list of concepts and their synonyms."""
    terms: list[str] = []
    for c in concepts:
        terms.extend(_quoted(t) for t in _concept_terms(c))
    if not terms:
        return ""
    if len(terms) == 1:
        return terms[0]
    return "(" + " OR ".join(terms) + ")"


def build_boolean_query(
    groups: dict[str, list[Concept]], provider: str = "ieee_xplore"
) -> str:
    """Build a Boolean search expression from role-grouped concepts.

    ``must`` and ``should`` concepts are AND-ed
    ``context`` / ``evidence``
    are appended with AND
    ``exclude`` concepts are negated with NOT.
    """
    parts: list[str] = []

    for role in ("must", "should"):
        clause = _or_group(groups.get(role, []))
        if clause:
            parts.append(clause)

    ctx_concepts = groups.get("context", []) + groups.get("evidence", [])
    ctx_clause = _or_group(ctx_concepts)
    if ctx_clause:
        parts.append(ctx_clause)

    expression = " AND ".join(parts) if parts else ""

    exclude = _or_group(groups.get("exclude", []))
    if exclude:
        expression = (
            f"({expression}) NOT ({exclude})"
            if expression
            else f"NOT ({exclude})"
        )

    return expression
