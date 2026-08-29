"""Render the shortlist an editor actually chooses from.

The design goal is that no line of this report is unattributable. A rank without
evidence, a COI verdict without a rule, or an email without a source URL is worse
than useless to an associate editor who may have to justify the invitation.

Three artefacts:

* ``shortlist.md``  — the table, for reading
* ``shortlist.csv`` — the same rows, for pasting into an editorial system
* ``dossiers/``     — one file per candidate, with the full audit trail
"""

from __future__ import annotations

import csv
import io
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from academia.reviewer import trajectory
from academia.reviewer.coi import CLEAR, CLEAR_WORDING
from academia.reviewer.enrich import EmailFinding
from academia.reviewer.profile import Profile
from academia.reviewer.rank import Candidate
from academia.store import repository as repo

EXPORT_COLUMNS = (
    "rank", "reviewer", "person_id", "orcid", "openalex_id", "ieee_author_id",
    "identity_method", "identity_confidence", "position", "position_source",
    "current_institution", "current_country", "current_year_from", "current_year_to",
    "current_source", "current_source_url", "historical_institution_count",
    "historical_country_count", "education_count", "score", "blocked", "coi_status",
    "coi_summary", "coi_finding_count", "evidence_count", "best_similarity",
    "evidence_year_from", "evidence_year_to", "component_topic", "component_method",
    "component_recent_expertise", "component_publication_evidence",
    "component_geographic", "component_reviewer_history", "email", "email_found",
    "email_source", "email_confidence", "email_source_url", "notes",
    "data_quality_warning", "invitation_count", "response_count", "acceptance_count",
)


@dataclass
class Row:
    rank: int
    candidate: Candidate
    email: EmailFinding

    @property
    def position(self) -> str:
        """Academic rank, as stated by a source. Never inferred from output."""
        from academia.reviewer.seniority import UNKNOWN, label

        person = self.candidate.person
        if person.rank != UNKNOWN:
            return label(person.rank)
        # A title nobody could classify still tells the editor more than
        # "unknown", which should mean nobody stated anything at all.
        return person.stated_title or label(UNKNOWN)

    @property
    def institution(self) -> str:
        affiliation = self.candidate.person.current_affiliation
        return affiliation.institution if affiliation else "unknown"

    @property
    def country(self) -> str:
        return self.candidate.person.country_code or "unknown"

    @property
    def score_text(self) -> str:
        return "blocked" if self.candidate.blocked else f"{self.candidate.score:.2f}"

    @property
    def dossier_name(self) -> str:
        return f"{self.rank:02d}-{self.candidate.person.person_id}.md"

    @property
    def evidence_text(self) -> str:
        count = len(self.candidate.evidence)
        if not count:
            return "none"
        years = [e.year for e in self.candidate.evidence if e.year]
        span = f"{min(years)}–{max(years)}" if years else "undated"
        # Linked, because the papers are what an editor judges a candidate on
        # and the dossier is where they are listed with their own links.
        return f"[{count} related papers ({span})](dossiers/{self.dossier_name})"

    @property
    def coi_text(self) -> str:
        verdict = self.candidate.verdict
        if verdict is None or verdict.status == CLEAR:
            return "Clear*"
        return f"{verdict.status}: {verdict.summary()}"

    @property
    def email_text(self) -> str:
        return self.email.email if self.email.found else "not found"

    def as_list(self) -> list[str]:
        return [
            str(self.rank),
            self.candidate.person.display_name,
            self.position,
            self.institution,
            self.country,
            trajectory.history_text(self.candidate.person),
            self.score_text,
            self.evidence_text,
            self.coi_text,
            self.email_text,
        ]


def build_rows(
    candidates: list[Candidate], emails: dict[str, EmailFinding] | None = None
) -> list[Row]:
    lookup = emails or {}
    return [
        Row(rank=index, candidate=candidate, email=lookup.get(candidate.person.person_id, EmailFinding()))
        for index, candidate in enumerate(candidates, start=1)
    ]


def render_markdown(
    conn: sqlite3.Connection,
    rows: list[Row],
    profile: Profile,
    policy_sources: list[str],
) -> str:
    out: list[str] = []
    out.append(f"# Reviewer shortlist — {profile.manuscript_id}")
    out.append("")
    out.append(f"Journal: {profile.journal or 'unspecified'}")
    out.append(f"Submission origin: {', '.join(profile.origin_countries) or 'unknown'}")
    out.append(f"Topics: {', '.join(profile.primary_topics) or 'none extracted'}")
    out.append(f"Policy: {', '.join(Path(p).name for p in policy_sources)}")
    out.append("")
    people = [row.candidate.person for row in rows]
    current = trajectory.country_exposure(people, historical=False)
    if current:
        out.append("Current-affiliation countries: " +
                   ", ".join(f"{country} {count}" for country, count in current.most_common()))
        out.append("")
    historical = trajectory.country_exposure(people, historical=True)
    if historical:
        out.append("Historical institution-country evidence (people may count in multiple countries): " +
                   ", ".join(f"{country} {count}" for country, count in historical.most_common()))
        out.append("")
    out.append("| " + " | ".join(EXPORT_COLUMNS) + " |")
    out.append("|" + "|".join(["---"] * len(EXPORT_COLUMNS)) + "|")
    for record in (_export_record(conn, row) for row in rows):
        cells = [str(record[column] if record[column] is not None else "") for column in EXPORT_COLUMNS]
        out.append("| " + " | ".join(cell.replace("|", "\\|") for cell in cells) + " |")
    out.append("")
    out.append(f"\\* Clear means **{CLEAR_WORDING}**. A bibliographic database cannot")
    out.append("prove that no personal, financial or competitive relationship exists.")
    out.append("")
    out.append("Blocked candidates are listed rather than hidden, so it is visible that")
    out.append("an obvious name was considered and why it was set aside.")
    return "\n".join(out) + "\n"


def render_reading_list(rows: list[Row]) -> str:
    """The papers behind the shortlist, most relevant first.

    Assembled once rather than left scattered across dossiers: an editor
    weighing a broad candidate list reads the literature, and the same paper
    frequently qualifies several candidates.
    """
    best: dict[str, list] = {}
    for row in rows:
        for item in row.candidate.evidence:
            name = row.candidate.person.display_name
            entry = best.get(item.paper_id)
            if entry is None:
                best[item.paper_id] = [item.similarity, item.title, item.year, item.url, [name]]
            else:
                entry[0] = max(entry[0], item.similarity)
                if name not in entry[4]:
                    entry[4].append(name)

    out = ["# Reading list — the work behind the shortlist", ""]
    out.append("Papers that qualified one or more candidates, most relevant first.")
    out.append("A paper that qualifies several people is listed once.")
    out.append("")
    for _score, title, year, url, names in sorted(best.values(), key=lambda v: -v[0]):
        heading = f"[{title}]({url})" if url else f"{title} (no link available)"
        out.append(f"- **{heading}** — {year or 'n.d.'}")
        out.append(f"  - qualifies: {', '.join(sorted(names))}")
    if not best:
        out.append("- none recorded")
    out.append("")
    return chr(10).join(out)


def _export_record(conn: sqlite3.Connection, row: Row) -> dict[str, object]:
    candidate = row.candidate
    person = candidate.person
    current = person.current_affiliation
    steps = trajectory.build(person)
    historical = [step for step in steps if step.kind != "current"]
    years = [item.year for item in candidate.evidence if item.year]
    verdict = candidate.verdict
    findings = verdict.findings if verdict else []
    invitations = repo.invitation_history(conn, person.person_id)
    education = person.education
    components = candidate.components
    return {
        "rank": row.rank,
        "reviewer": person.display_name,
        "person_id": person.person_id,
        "orcid": person.orcid,
        "openalex_id": person.openalex_id,
        "ieee_author_id": person.ieee_author_id,
        "identity_method": person.resolution_method,
        "identity_confidence": round(person.confidence, 3),
        "position": row.position,
        "position_source": person.rank_source,
        "current_institution": current.institution if current else "",
        "current_country": current.country_code if current else "",
        "current_year_from": current.year_from if current else None,
        "current_year_to": current.year_to if current else None,
        "current_source": current.source if current else "",
        "current_source_url": current.source_url if current else "",
        "historical_institution_count": len(historical),
        "historical_country_count": len({step.country for step in historical if step.country}),
        "education_count": len(education),
        "score": "" if candidate.blocked else round(candidate.score, 6),
        "blocked": candidate.blocked,
        "coi_status": candidate.coi_status,
        "coi_summary": verdict.summary() if verdict else CLEAR_WORDING,
        "coi_finding_count": len(findings),
        "evidence_count": len(candidate.evidence),
        "best_similarity": max((item.similarity for item in candidate.evidence), default=0.0),
        "evidence_year_from": min(years) if years else None,
        "evidence_year_to": max(years) if years else None,
        "component_topic": components.get("topic", ""),
        "component_method": components.get("method", ""),
        "component_recent_expertise": components.get("recent_expertise", ""),
        "component_publication_evidence": components.get("publication_evidence", ""),
        "component_geographic": components.get("geographic", ""),
        "component_reviewer_history": components.get("reviewer_history", ""),
        "email": row.email.email,
        "email_found": row.email.found,
        "email_source": row.email.source,
        "email_confidence": row.email.confidence,
        "email_source_url": row.email.source_url,
        "notes": ";".join(candidate.notes),
        "data_quality_warning": trajectory.quality_note(person),
        "invitation_count": len(invitations),
        "response_count": sum(bool(item["responded"]) for item in invitations),
        "acceptance_count": sum(bool(item["accepted"]) for item in invitations),
    }


def render_csv(conn: sqlite3.Connection, rows: list[Row]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=EXPORT_COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(_export_record(conn, row))
    return buffer.getvalue()


def _detail_csv(columns: tuple[str, ...], records: list[dict[str, object]]) -> str:
    """Render a normalized Excel-friendly detail table without nested cells."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)
    return buffer.getvalue()


DETAIL_KEY_COLUMNS = ("rank", "reviewer", "person_id")


def detail_exports(conn: sqlite3.Connection, rows: list[Row]) -> dict[str, str]:
    institutions, education, evidence, coi, invitations = [], [], [], [], []
    for row in rows:
        person = row.candidate.person
        key = {"rank": row.rank, "reviewer": person.display_name, "person_id": person.person_id}
        for step in trajectory.build(person):
            institutions.append(key | {
                "kind": step.kind, "institution": step.institution, "country": step.country,
                "year_from": step.year_from, "year_to": step.year_to,
                "source": step.source, "source_url": step.source_url,
            })
        for entry in person.education:
            education.append(key | {
                "institution": entry.institution, "degree": entry.degree, "field": entry.field,
                "year_from": entry.year_from, "year_to": entry.year_to,
                "advisor_person_id": entry.advisor_person_id, "source": entry.source,
                "source_url": entry.source_url,
            })
        for item in row.candidate.evidence:
            evidence.append(key | {
                "paper_id": item.paper_id, "title": item.title, "year": item.year,
                "doi": item.doi, "url": item.url, "similarity": item.similarity,
            })
        verdict = row.candidate.verdict
        for finding in verdict.findings if verdict else []:
            coi.append(key | {"rule": finding.rule, "status": finding.status, "evidence": finding.evidence})
        for item in repo.invitation_history(conn, person.person_id):
            invitations.append(key | {
                "manuscript_id": item["ms_id"], "invited_at": item["invited_at"],
                "responded": bool(item["responded"]), "accepted": bool(item["accepted"]),
            })
    specs = {
        "institutions.csv": ((*DETAIL_KEY_COLUMNS, "kind", "institution", "country", "year_from", "year_to", "source", "source_url"), institutions),
        "education.csv": ((*DETAIL_KEY_COLUMNS, "institution", "degree", "field", "year_from", "year_to", "advisor_person_id", "source", "source_url"), education),
        "evidence.csv": ((*DETAIL_KEY_COLUMNS, "paper_id", "title", "year", "doi", "url", "similarity"), evidence),
        "coi-findings.csv": ((*DETAIL_KEY_COLUMNS, "rule", "status", "evidence"), coi),
        "invitations.csv": ((*DETAIL_KEY_COLUMNS, "manuscript_id", "invited_at", "responded", "accepted"), invitations),
    }
    return {name: _detail_csv(columns, records) for name, (columns, records) in specs.items()}


def render_dossier(conn: sqlite3.Connection, row: Row) -> str:
    person = row.candidate.person
    out: list[str] = []
    out.append(f"# {person.display_name}")
    out.append("")
    out.append(f"- Position: {row.position}")
    if person.rank_source:
        out.append(f"  - stated at {person.rank_source}")
    out.append(f"- Institution: {row.institution}")
    out.append(f"- Country: {row.country}")
    if person.orcid:
        out.append(f"- ORCID: https://orcid.org/{person.orcid}")
    out.append(
        f"- Identity resolved by: {person.resolution_method} "
        f"(confidence {person.confidence:.2f})"
    )
    if row.email.found:
        out.append(f"- Email: {row.email.email}")
        out.append(f"  - source: {row.email.source} ({row.email.source_url or 'no url'})")
        out.append(f"  - confidence: {row.email.confidence:.2f}")
    else:
        out.append("- Email: not found — no public professional address was located")
        out.append("  - no address is guessed from a name/domain pattern")
    out.append("")

    if person.education:
        out.append("## Background")
        out.append("")
        for entry in person.education:
            years = "–".join(str(y) for y in (entry.year_from, entry.year_to) if y) or "dates unknown"
            degree = entry.degree or "degree unknown"
            out.append(f"- {degree}, {entry.institution or 'institution unknown'} ({years})")
            out.append(f"  - source: {entry.source} {entry.source_url}")
        out.append("")
    else:
        out.append("## Background")
        out.append("")
        out.append("Not recorded. ORCID carries an education section for a minority of")
        out.append("researchers, and nothing here is inferred.")
        out.append("")

    steps = trajectory.build(person)
    if steps:
        out.append("## Institutional trajectory")
        out.append("")
        for step in steps:
            country = f", {step.country}" if step.country else ""
            source = f" — {step.source} {step.source_url}".rstrip() if step.source else ""
            out.append(
                f"- **{step.kind}**: {step.institution}{country} ({step.years}){source}"
            )
        out.append("")
    if note := trajectory.quality_note(person):
        out.append(f"> Data-quality warning: {note}. OpenAlex history is publication-affiliation")
        out.append("> evidence, not proof of employment, nationality or ethnicity.")
        out.append("")

    out.append("## Why this candidate")
    out.append("")
    if row.candidate.components:
        for name, value in sorted(row.candidate.components.items(), key=lambda kv: -kv[1]):
            out.append(f"- {name}: {value:.2f}")
    else:
        out.append("- not scored (excluded before scoring)")
    out.append("")

    out.append("## Evidence")
    out.append("")
    for item in row.candidate.evidence:
        title = f"[{item.title}]({item.url})" if item.url else item.title
        out.append(
            f"- [{item.year or 'n.d.'}] {title} "
            f"({item.position} author, similarity {item.similarity:.2f})"
        )
    if not row.candidate.evidence:
        out.append("- none recorded")
    out.append("")

    out.append("## Conflict-of-interest audit")
    out.append("")
    verdict = row.candidate.verdict
    if verdict is None or not verdict.findings:
        out.append(f"- {CLEAR_WORDING}")
        out.append("- checks run: manuscript authorship, exclusion list, co-authorship window,")
        out.append("  institutional overlap, shared doctorate, advisor relationship, citation density")
    else:
        for finding in verdict.findings:
            out.append(f"- **{finding.status}** {finding.rule}")
            for key, value in finding.evidence.items():
                out.append(f"  - {key}: {value}")
    out.append("")

    if row.candidate.notes:
        out.append("## Notes")
        out.append("")
        for note in row.candidate.notes:
            out.append(f"- {note}")
        out.append("")

    history = repo.invitation_history(conn, person.person_id)
    if history:
        out.append("## Previous invitations")
        out.append("")
        for entry in history:
            state = "accepted" if entry["accepted"] else ("responded" if entry["responded"] else "no response")
            out.append(f"- {entry['ms_id']} ({entry['invited_at']}): {state}")
        out.append("")

    return "\n".join(out) + "\n"


def write_all(
    conn: sqlite3.Connection,
    directory: Path,
    rows: list[Row],
    profile: Profile,
    policy_sources: list[str],
) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    dossier_dir = directory / "dossiers"
    dossier_dir.mkdir(parents=True, exist_ok=True)
    # Dossier filenames carry the rank, so a re-run after tuning the profile
    # would otherwise leave last run's ranking sitting beside this one's.
    for previous in dossier_dir.glob("[0-9][0-9]-person-*.md"):
        previous.unlink()

    shortlist = directory / "shortlist.md"
    shortlist.write_text(render_markdown(conn, rows, profile, policy_sources), encoding="utf-8")

    csv_path = directory / "shortlist.csv"
    csv_path.write_text(render_csv(conn, rows), encoding="utf-8-sig")

    detail_paths = {}
    for name, content in detail_exports(conn, rows).items():
        path = directory / name
        path.write_text(content, encoding="utf-8-sig")
        detail_paths[name.removesuffix(".csv").replace("-", "_")] = path

    reading = directory / "reading-list.md"
    reading.write_text(render_reading_list(rows), encoding="utf-8")

    for row in rows:
        name = f"{row.rank:02d}-{row.candidate.person.person_id}.md"
        (dossier_dir / name).write_text(render_dossier(conn, row), encoding="utf-8")

    return {
        "shortlist": shortlist,
        "csv": csv_path,
        "reading_list": reading,
        "dossiers": dossier_dir,
    } | detail_paths
