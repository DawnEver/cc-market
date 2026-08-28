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

from academia.reviewer.coi import CLEAR, CLEAR_WORDING
from academia.reviewer.enrich import EmailFinding
from academia.reviewer.profile import Profile
from academia.reviewer.rank import Candidate
from academia.store import repository as repo

COLUMNS = (
    "Rank",
    "Reviewer",
    "Institution",
    "Country",
    "Score",
    "Evidence",
    "COI",
    "Email",
)


@dataclass
class Row:
    rank: int
    candidate: Candidate
    email: EmailFinding

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
    def evidence_text(self) -> str:
        count = len(self.candidate.evidence)
        if not count:
            return "none"
        years = [e.year for e in self.candidate.evidence if e.year]
        span = f"{min(years)}–{max(years)}" if years else "undated"
        return f"{count} related papers ({span})"

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
            self.institution,
            self.country,
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


def render_markdown(rows: list[Row], profile: Profile, policy_sources: list[str]) -> str:
    out: list[str] = []
    out.append(f"# Reviewer shortlist — {profile.manuscript_id}")
    out.append("")
    out.append(f"Journal: {profile.journal or 'unspecified'}")
    out.append(f"Submission origin: {', '.join(profile.origin_countries) or 'unknown'}")
    out.append(f"Topics: {', '.join(profile.primary_topics) or 'none extracted'}")
    out.append(f"Policy: {', '.join(Path(p).name for p in policy_sources)}")
    out.append("")
    out.append("| " + " | ".join(COLUMNS) + " |")
    out.append("|" + "|".join(["---"] * len(COLUMNS)) + "|")
    for row in rows:
        out.append("| " + " | ".join(cell.replace("|", "\\|") for cell in row.as_list()) + " |")
    out.append("")
    out.append(f"\\* Clear means **{CLEAR_WORDING}**. A bibliographic database cannot")
    out.append("prove that no personal, financial or competitive relationship exists.")
    out.append("")
    out.append("Blocked candidates are listed rather than hidden, so it is visible that")
    out.append("an obvious name was considered and why it was set aside.")
    return "\n".join(out) + "\n"


def render_csv(rows: list[Row]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(COLUMNS)
    for row in rows:
        writer.writerow(row.as_list())
    return buffer.getvalue()


def render_dossier(conn: sqlite3.Connection, row: Row) -> str:
    person = row.candidate.person
    out: list[str] = []
    out.append(f"# {person.display_name}")
    out.append("")
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

    if len(person.affiliations) > 1:
        out.append("## Career")
        out.append("")
        for affiliation in person.affiliations:
            years = "–".join(str(y) for y in (affiliation.year_from, affiliation.year_to) if y)
            marker = " (current)" if affiliation.is_current else ""
            out.append(f"- {affiliation.institution} {years}{marker} — {affiliation.source}")
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
        out.append(
            f"- [{item.year or 'n.d.'}] {item.title} "
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

    shortlist = directory / "shortlist.md"
    shortlist.write_text(render_markdown(rows, profile, policy_sources), encoding="utf-8")

    csv_path = directory / "shortlist.csv"
    csv_path.write_text(render_csv(rows), encoding="utf-8")

    for row in rows:
        name = f"{row.rank:02d}-{row.candidate.person.person_id}.md"
        (dossier_dir / name).write_text(render_dossier(conn, row), encoding="utf-8")

    return {"shortlist": shortlist, "csv": csv_path, "dossiers": dossier_dir}
