"""The workbook the editor is handed — the one deliverable of a discovery run.

Everything else a run writes is working material: CSVs shaped for an audit
trail, dossiers, a reading list. They stay in ``5-shortlist/`` for anyone who
wants to disagree with a verdict. What leaves the workspace is one file, named
after the case and sitting beside the manuscript it is about.

The audit CSV behind it is one row per candidate and one column per filter
*input*: the right shape for a trail, the wrong shape for a reader who does not
already know the pipeline. Out of sixty-odd columns only eight are conclusions;
the rest are the arithmetic behind them. So the workbook splits into three
layers:

* ``decision`` — what an editor actually filters on: one verdict per dimension,
  a single ``blocking_reason``, the contact details and a link to the person.
  Opens first.
* ``audit``    — every input, ``filter_`` prefixes dropped and the constant
  thresholds moved into the glossary, so what is left varies per person.
* ``columns``  — how to read the thing, then a line per column.

``rev-disc report`` writes it. To rebuild one by hand from a CSV that is already
on disk:

    uv run python -m academia.reviewer.workbook         <workspace>/ongoing/<slug>/5-shortlist/contact-list-audit.csv

Nothing in this file is confidential: it reads whatever CSV it is handed and
never touches the manuscript.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

DROP = ("person_id",)
RENAME = {"recommendation": "recommend_for_reviewer", "filter_details": "reasoning"}

#: Columns that state a policy threshold rather than a fact about the person.
#: Dropped from the sheet when they hold one value for everybody — sixty columns
#: is already too many to scan, and a column that never varies cannot filter.
THRESHOLD_SUFFIXES = ("_minimum", "_maximum", "_window_years", "_countries")

#: Spelling out a country reads better than a bare code in a column heading.
#: Display only — the list of restricted countries itself comes from the policy,
#: never from here, and a code absent from this map simply prints as the code.
COUNTRY_NAMES = {
    "CN": "China",
    "IN": "India",
    "IR": "Iran",
    "KP": "North Korea",
    "RU": "Russia",
    "SY": "Syria",
}

WHITE_COLUMNS = ("rank", "reviewer", "email", "institution", "profile_url")

#: The link column. Written as a hyperlink rather than raw text, because the
#: workbook is the only thing the editor gets and a URL they cannot click is a
#: URL they retype.
LINK_COLUMN = "profile_url"

#: What each rule's block of columns is called in the sheet, in sheet order.
#: Keyed by rule name, and that is the whole mapping: every fact a rule emits is
#: named ``<rule>_<fact>``, so the block a column belongs to is readable off the
#: column itself. This used to be a list of hand-maintained prefixes that had
#: drifted — ``recent_`` collected both the topic-activity columns and the
#: invitation-count ones, and no prefix matched a rule that had been renamed.
RULE_DIMENSIONS: dict[str, str] = {
    "coi": "Conflict of interest",
    "author_country": "Geography",
    "restricted_country": "Restricted country",
    "related_journals": "Related-journal record",
    "relevant_activity": "Recent activity on this topic",
    "recent_activity": "Still publishing",
    "doctoral_year": "Doctoral floor",
    "seniority": "Seniority",
}

#: The two blocks that are not a rule: who this is, and what to do about them.
IDENTITY_COLUMNS = (
    "rank", "reviewer", "email", "institution", "current_country", "profile_url",
)
DECISION_BLOCK = ("recommend_for_reviewer", "blocking_reason")

#: What each column is called in the sheet. The internal name stays the key
#: everywhere in this module but never reaches the workbook: a reader who has
#: not seen the pipeline should not have to decode a field name to use the file.
#: ``{...}`` placeholders are filled from the run's own thresholds, so a heading
#: states the rule this run applied rather than a number frozen into the code.
LABELS: dict[str, str] = {
    "rank": "Rank",
    "reviewer": "Reviewer name",
    "email": "Email address",
    "institution": "Current institution",
    "current_country": "Current country",
    "profile_url": "Homepage or paper",
    "recommend_for_reviewer": "Recommend as reviewer",
    "blocking_reason": "Why not recommended",
    # Conflict of interest
    "coi": "Rule: no conflict of interest (severity = 0)",
    "coi_severity": "Conflict severity (0 none, 1 review, 2 blocking)",
    "coi_finding_count": "Number of conflicts found",
    # Geography — scores, never excludes
    "author_country_reference": "Country compared with the submission",
    "author_country_cross_region": "In a different country from the submission? (adds score, never excludes)",
    # Restricted country
    "restricted_country": "Rule: not working in {restricted_country_countries}",
    "restricted_country_current": "Country of the current affiliation",
    "restricted_country_countries": "Countries this journal will not invite from",
    # Related-journal record
    "related_journals": "Rule: related journal papers ≥ {related_journals_minimum}",
    "related_journals_count": "Related journal papers — {related_journals_minimum} required",
    "related_journals_minimum": "Related journal papers required",
    "related_journals_nonjournal": "Related conference papers (never count towards the floor)",
    "related_journals_unresolved": "Related papers, journal or conference unclear",
    "related_journals_first_author": "Of the related papers, as first author",
    "related_journals_last_author": "Of those, as last author (the supervisor slot)",
    "related_journals_leading": "Of those, in a leading role (first or last)",
    "related_journals_position_weight_mean": "Author-position score, average (1.0 = always leading)",
    # Recent activity on this topic
    "relevant_activity": "Rule: ≥ {relevant_activity_minimum} paper on this topic in the last {relevant_activity_window_years} years",
    "relevant_activity_papers": "Papers on this topic in the last {relevant_activity_window_years} years — {relevant_activity_minimum} required",
    "relevant_activity_latest_year": "Most recent paper on this topic",
    "relevant_activity_minimum": "Papers on this topic required",
    "relevant_activity_window_years": "Length of the topic-activity window, in years",
    # Still publishing
    "recent_activity": "Rule: still publishing — ≥ {recent_activity_minimum} paper in the last {recent_activity_window_years} years",
    "recent_activity_papers": "Papers of any kind in the last {recent_activity_window_years} years — {recent_activity_minimum} required",
    "recent_activity_latest_year": "Most recent publication year, any topic",
    "recent_activity_source": "Whether the count came from the publication profile or only from papers this run harvested",
    "recent_activity_minimum": "Papers of any kind required",
    "recent_activity_window_years": "Length of the still-publishing window, in years",
    # Doctoral floor
    "doctoral_year": "Rule: if a PhD student, year of study ≥ {doctoral_year_minimum}",
    "doctoral_year_is_doctoral": "Is a PhD student",
    "doctoral_year_value": "Year of PhD study — {doctoral_year_minimum} required",
    "doctoral_year_minimum": "Minimum year of PhD study",
    # Seniority
    "seniority": "Rule: {seniority_band} into an independent career",
    "seniority_years": "Years into an independent career",
    "seniority_basis": "What that is counted from — a stated doctorate year where there is one, otherwise the first publication",
    "seniority_since": "The year it is counted from",
    "seniority_minimum": "Years required",
    "seniority_maximum": "Years this journal prefers to stay within (0 = no ceiling). A preference only; it excludes nobody.",
    # Invitation response
    "reasoning": "Reason for each check, in words",
}


#: What ``Why not recommended`` says. A dimension name is not a reason.
BLOCKING_REASONS = {
    "coi": "Conflict of interest with the authors",
    "restricted_country": "Works in a restricted country",
    "related_journals": "Too few papers in related journals",
    "relevant_activity": "Nothing published on this topic lately",
    "recent_activity": "Not publishing at all lately",
    "doctoral_year": "PhD student below the year floor",
    "seniority": "Too early in an independent career",
}



#: Policy thresholds read out of the CSV, so a header states the rule this run
#: actually applied rather than a number frozen into this script.
THRESHOLDS: dict[str, str] = {}

#: The same thresholds unformatted, for comparing numbers against.
THRESHOLD_NUMBERS: dict[str, str] = {}


def _readable(name: str, value: str) -> str:
    """Rates read as percentages; everything else is already a plain number."""
    if "_rate_" in name:
        try:
            return f"{float(value):.0%}"
        except ValueError:
            pass
    return value


def label_of(name: str) -> str:
    return LABELS.get(name, name).format_map(THRESHOLDS)


def seniority_band(minimum: str, maximum: str) -> str:
    """The seniority rule's heading, from the bounds that are actually in force.

    The only two-sided rule in the policy, and the heading used to name its
    floor alone — so a journal whose whole reason for setting the rule is a
    ten-year ceiling read "at least 3 years", which is true, is what the
    inherited default says, and is not what the run applied.
    """
    try:
        floor, ceiling = int(float(minimum or 0)), int(float(maximum or 0))
    except ValueError:
        return "a stated number of years"
    if floor and ceiling:
        return f"between {floor} and {ceiling} years"
    if ceiling:
        return f"under {ceiling} years"
    if floor:
        return f"at least {floor} years"
    return "any number of years"


def missing_thresholds(header: list[str]) -> list[str]:
    """Placeholders the headings need but the CSV did not supply.

    Only the columns actually present are checked. A journal that switches a
    rule off drops its columns from the CSV, and demanding a threshold for a
    rule nobody ran would refuse a perfectly good file.
    """
    import string

    wanted: set[str] = set()
    for name in header:
        for _, field, _, _ in string.Formatter().parse(LABELS.get(name, "")):
            if field:
                wanted.add(field)
    return sorted(wanted - set(THRESHOLDS))

#: The verdict column of each rule, in the order a blocking reason is read.
#: Conflict first because it is the only one that is about the manuscript rather
#: than about the person; the rest follow the order the rules ran in.
#: ``RULE_DIMENSIONS`` already leads with the conflict rule, and its order is
#: the order the rules ran in. A name here that has no verdict column — the
#: geography preference states a fact and reaches no verdict — simply drops out.
VERDICTS_IN_ORDER = tuple(RULE_DIMENSIONS)

#: PASS / FILTERED / PREFERENCE_MISSED are pipeline vocabulary. A reader who has
#: never seen the pipeline gets the same states in words they already know.
VERDICT_TEXT = {
    "recommend": "Recommend",
    "check_first": "Check first",
    "do_not_invite": "Do not invite",
    "PASS": "Pass",
    "CLEAR": "Pass",
    "FILTERED": "Fail",
    "BLOCK": "Fail",
    "VERIFY": "No evidence",
    "REVIEW": "Check by hand",
    "PREFERENCE_MISSED": "Below preference",
}

VERDICT_STYLE = {
    "Recommend": ("C6EFCE", "0B6B2E"),
    "Check first": ("FFE9A8", "8A6100"),
    "Do not invite": ("F8C9C6", "9C0006"),
    "Pass": ("C6EFCE", "0B6B2E"),
    "Fail": ("F8C9C6", "9C0006"),
    "No evidence": ("FFE9A8", "8A6100"),
    "Below preference": ("FFE9A8", "8A6100"),
    "Check by hand": ("FFE9A8", "8A6100"),
}

#: The verdicts that mean a rule excluded this candidate, and so name a
#: blocking reason. A conflict reported for review is not one of them: it asks
#: for a human, and a candidate awaiting that is still in play.
EXCLUDING_VERDICTS = frozenset({"FILTERED", "BLOCK"})

#: A measured number is judged against the same threshold its rule uses, so the
#: figure itself reads pass or fail without cross-referencing the rule column.
#: (column, threshold column, the number must reach the threshold)
MEASURES: tuple[tuple[str, str], ...] = (
    ("related_journals_count", "related_journals_minimum"),
    ("relevant_activity_papers", "relevant_activity_minimum"),
    ("recent_activity_papers", "recent_activity_minimum"),
    ("seniority_years", "seniority_minimum"),
    ("doctoral_year_value", "doctoral_year_minimum"),
)

#: A rule that measures something shows the measurement, not a verdict: the
#: heading already states the threshold, so the figure carries the whole story
#: and an editor can sort on it. The verdict still sets the colour, because it
#: is the only thing that knows the difference between failing a rule and having
#: nothing to judge. Rules with nothing to count — a country is on a list or it
#: is not — keep their word.
RULE_MEASURES = {
    "coi": "coi_severity",
    "related_journals": "related_journals_count",
    "relevant_activity": "relevant_activity_papers",
    "recent_activity": "recent_activity_papers",
    "seniority": "seniority_years",
    "doctoral_year": "doctoral_year_value",
}

DECISION_COLUMNS = (
    "rank",
    "reviewer",
    "institution",
    "current_country",
    "email",
    "profile_url",
    "recommend_for_reviewer",
    "blocking_reason",
    *VERDICTS_IN_ORDER,
    "reasoning",
)

HOW_TO_READ = [
    ("How to read this workbook", ""),
    (
        "1. Start on the decision sheet.",
        "One row per candidate, one column per dimension. Filter ‘Recommend as reviewer’ for Recommend (cleared everything) or Check first (cleared every rule, something still needs a human).",
    ),
    (
        "2. To ask why somebody is out, filter ‘Why not recommended’.",
        "It states the first check they failed, and is blank for everyone still in play — including anyone whose only flag is a conflict marked for review, which asks for a human rather than excluding them.",
    ),
    (
        "3. A Rule column shows a number where there is one to show.",
        "The heading states the threshold, so the figure underneath answers the rule on its own and can be sorted. Its colour is the verdict: green the rule is satisfied, red the candidate is excluded by it, amber either nothing on record to judge (the rule abstains rather than guess) or a preference rather than a requirement (it excludes nobody). Where there is nothing to count, or nothing was measured for this person, the cell says Pass, Fail, No evidence or Below preference instead.",
    ),
    (
        "4. ‘Homepage or paper’ is a link, not a citation.",
        "It opens the ORCID record or publication profile where one exists, and otherwise the paper of theirs closest to this manuscript. Read it before inviting anybody whose name you do not already know.",
    ),
    (
        "5. The audit sheet is the arithmetic behind each verdict.",
        "Same rows, same order, every input the rules read. Go there to disagree with a verdict, not to make a shortlist.",
    ),
    (
        "6. Measured numbers are coloured against their own threshold.",
        "A count or rate is green once it reaches the figure named in its own column heading and red until it does, so a number reads pass or fail without looking across at the rule column.",
    ),
    ("", ""),
]


def dimension_of(name: str) -> str:
    """Which block a column belongs to, read off the column's own name.

    Every fact a rule emits is named ``<rule>_<fact>``, so the longest rule
    name that prefixes a column is the rule that produced it. Longest wins
    because ``recent_activity`` and ``relevant_activity`` are distinct rules and
    a shorter prefix must not swallow a longer one.
    """
    if name in IDENTITY_COLUMNS:
        return "Identity"
    if name in DECISION_BLOCK:
        return "Decision"
    if name == "reasoning":
        return "Reasoning"
    best, best_len = "", -1
    for rule, label in RULE_DIMENSIONS.items():
        if (name == rule or name.startswith(rule + "_")) and len(rule) > best_len:
            best, best_len = label, len(rule)
    return best


def cast(value: str):
    if value == "":
        return None
    if value in ("True", "False"):
        return value == "True"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


GLOSSARY: dict[str, str] = {
    "rank": "Shortlist position, best expertise score first.",
    "reviewer": "Candidate name as resolved during identity matching.",
    "email": "Best verified contact address. Blank means none was found in public data, which is a gap in the sources and never a mark against the person — such a candidate reads Check first, and the editorial system can address the invitation.",
    "institution": "Current affiliation.",
    "current_country": "ISO code of the current affiliation, never nationality.",
    "profile_url": "Where to read about this person: their ORCID record, their publication profile, or failing both the closest of their papers to this manuscript. Whichever it is, it is a page that already existed — never a search built here.",
    "recommend_for_reviewer": "Recommend = every required rule passed and an address was verified against the institution. Check first = every rule passed but something still needs a human (usually the address). Do not invite = a rule excluded them.",
    "blocking_reason": "The first rule that excluded this candidate; blank when none did, including when the only flag is a conflict marked for review. Derived here, not in the CSV.",
    "coi": "Conflict-of-interest verdict under coi.toml plus the journal overlay. Three states: clear, review-level (asks for a human, excludes nobody), blocking.",
    "coi_severity": "0 clear, 1 review-level, 2 blocking.",
    "coi_finding_count": "Number of COI findings recorded against this person.",
    "author_country_reference": "The candidate's country read against the submission's country of origin.",
    "author_country_cross_region": "1 when the candidate sits outside the submission's origin country. Under prefer_cross_region this only scores; it never excludes.",
    "restricted_country": "Fails anyone whose current affiliation is in a country the journal will not invite from. An unknown country abstains rather than guessing, and is sent for confirmation.",
    "restricted_country_current": "Country of the current affiliation, as an ISO code.",
    "restricted_country_countries": "The journal's restricted list, from its own policy file.",
    "related_journals": "Passes once the verified related-journal count reaches the minimum. Counted over the evidence that qualified this candidate, so it asks about *this* topic rather than about output in general.",
    "related_journals_count": "Verified journal papers in venues related to the submission.",
    "related_journals_nonjournal": "Related conference or other non-journal items. They never satisfy the floor.",
    "related_journals_unresolved": "Related items whose venue type no source stated. Not counted, and not held against anybody — a candidate who misses the floor only on these is sent for a human check.",
    "related_journals_first_author": "Related papers where the candidate is first author.",
    "related_journals_last_author": "Related papers where the candidate is last author, the usual supervisor slot.",
    "related_journals_leading": "Related papers in a leading role: first or last. Audited, never decisive — a supervisor slot is not a qualification.",
    "related_journals_position_weight_mean": "Mean authorship-position weight. Near 1.0 means consistently leading.",
    "relevant_activity": "Papers on this manuscript's topic inside the window, counted over the run's own relevant corpus — the only source that can say what is relevant to this submission.",
    "relevant_activity_papers": "How many of those fall inside the window.",
    "relevant_activity_latest_year": "Year of the most recent paper on this topic.",
    "recent_activity": "Is this person publishing at all? Read from their own publication profile, not from the papers this run harvested: measured against the harvest a live run called 19 of 22 candidates dormant, because their latest work was not on this topic.",
    "recent_activity_papers": "Papers of any kind inside the window.",
    "recent_activity_latest_year": "Year of the most recent publication, any topic.",
    "recent_activity_source": "profile = their own bibliographic record. harvest = only what this run found, which is weaker evidence and is labelled as such rather than implied.",
    "doctoral_year": "Passes unless the candidate is a doctoral student below the journal's floor. A student whose year of study is nowhere stated is kept and sent for confirmation — not configurable, because turning that gap into an exclusion would remove the people with the thinnest records rather than the ones who are too junior.",
    "doctoral_year_is_doctoral": "1 when the resolved rank is doctoral student.",
    "doctoral_year_value": "Year of doctoral study; blank for everyone who is not a student.",
    "seniority": "How far into an independent career this person is, as one axis with a floor and a preferred ceiling. This was two rules — one counting from the doctorate, one from the first paper — which measured the same thing from different sources and disagreed by up to 28 years.",
    "seniority_years": "The figure itself.",
    "seniority_basis": "doctorate = counted from a stated doctorate year, the better basis. first publication = the fallback, because ORCID states a doctorate year for a minority of researchers in this field.",
    "seniority_since": "The year the count starts from, so the figure can be checked.",
    "seniority_maximum": "The preferred ceiling. It scores and never excludes, whatever the mode says: refusing a reviewer for being too experienced is not something an editor should be able to state by accident, and a required ceiling once emptied a live shortlist of every senior name in it.",
    "reasoning": "One human-readable sentence per rule. The reason an editor can disagree with.",
}


def _style_header(ws, header: list[str]) -> None:
    grey = PatternFill("solid", fgColor="D9D9D9")
    rule = Side(style="medium", color="8C97A3")
    thin = Side(style="thin", color="9AA5B1")
    previous = None
    for column, name in enumerate(header, start=1):
        cell = ws.cell(row=1, column=column)
        cell.value = label_of(name)
        cell.font = Font(bold=True, size=9)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        if name not in WHITE_COLUMNS:
            cell.fill = grey
        label = dimension_of(name)
        starts_block = previous is not None and label != previous
        cell.border = Border(bottom=thin, left=rule if starts_block else None)
        if starts_block:
            # The rule runs the full height so the blocks stay legible when the
            # header scrolls out of sight.
            for below in ws[get_column_letter(column)][1:]:
                below.border = Border(left=rule)
        previous = label


PASS_FONT = Font(color="0B6B2E", bold=True)
FAIL_FONT = Font(color="9C0006", bold=True)


def _floor_of(name: str) -> float | None:
    for column, threshold in MEASURES:
        if column == name:
            try:
                return float(THRESHOLD_NUMBERS[threshold])
            except (KeyError, ValueError):
                return None
    return None


def _style_body(ws, header: list[str], verdicts: list[list[str | None]]) -> None:
    floors = [_floor_of(name) for name in header]
    for index, row in enumerate(ws.iter_rows(min_row=2)):
        for position, cell in enumerate(row):
            verdict = verdicts[index][position]
            style = VERDICT_STYLE.get(verdict or cell.value) if isinstance(verdict or cell.value, str) else None
            if style:
                fill, colour = style
                cell.fill = PatternFill("solid", fgColor=fill)
                cell.font = Font(color=colour, bold=True)
            elif cell.value is True:
                cell.font = PASS_FONT
            elif cell.value is False:
                cell.font = FAIL_FONT
            elif floors[position] is not None and isinstance(cell.value, (int, float)):
                cell.font = PASS_FONT if cell.value >= floors[position] else FAIL_FONT


LINK_FONT = Font(color="0563C1", underline="single")


def _style_links(ws, header: list[str]) -> None:
    """Make the one URL column clickable, and only where there is a URL.

    A cell holding the word for "nothing found" must not become a hyperlink to
    it, so the test is the value itself rather than the column.
    """
    if LINK_COLUMN not in header:
        return
    letter = get_column_letter(header.index(LINK_COLUMN) + 1)
    for cell in ws[letter][1:]:
        target = str(cell.value or "")
        if not target.startswith(("http://", "https://")):
            continue
        cell.hyperlink = target
        cell.font = LINK_FONT


def _finish(
    ws,
    header: list[str],
    body: list[list],
    verdicts: list[list[str | None]],
    *,
    freeze: str,
    wide: tuple[str, ...],
) -> None:
    _style_header(ws, header)
    _style_body(ws, header, verdicts)
    _style_links(ws, header)
    ws.freeze_panes = freeze
    ws.auto_filter.ref = ws.dimensions
    ws.row_dimensions[1].height = 58
    for column, name in enumerate(header, start=1):
        letter = get_column_letter(column)
        if name in wide:
            ws.column_dimensions[letter].width = 60
            for cell in ws[letter][1:]:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
            continue
        # The heading wraps, so it does not get a vote on the width: sizing to a
        # sixty-character rule sentence would push every neighbour off-screen.
        # The data decides, within a range narrow enough to keep the dimensions
        # readable side by side.
        widest = max([len(str(r[column - 1])) for r in body] or [0])
        # A URL truncated to 24 characters is unreadable even when it is still
        # clickable, so the link column gets its own ceiling.
        ceiling = 44 if name == LINK_COLUMN else 24
        ws.column_dimensions[letter].width = min(max(widest + 2, 8), ceiling)


def journal_of(src: Path) -> str:
    """The journal slug this case was scored under, from its own profile.

    Read from the derived profile the pipeline writes, not from the manuscript:
    one key, and nothing else in that file is touched. A workspace laid out some
    other way simply yields no slug, and the caller falls back.
    """
    for directory in src.parents:
        profile = directory / "1-manuscript" / "paper_profile.json"
        if profile.exists():
            try:
                return str(json.loads(profile.read_text(encoding="utf-8")).get("journal") or "")
            except (OSError, ValueError):
                return ""
    return ""


def restricted_countries(src: Path, journal: str) -> frozenset[str]:
    """The journal's restricted-country list, straight from the policy.

    Duplicating the list here would mean a workbook could go on naming countries
    a journal had stopped restricting. When the policy cannot be read at all —
    the library is not importable, or the slug is unknown — say so rather than
    guess a list.
    """
    slug = journal or journal_of(src)
    if not slug:
        return frozenset()
    try:
        from academia.reviewer.policy import load_policy
    except ImportError:  # pragma: no cover - only when run outside the project
        return frozenset()
    return load_policy(slug).constraint("restricted_country").upper_set("countries")


def describe_countries(codes: frozenset[str]) -> str:
    if not codes:
        return "a restricted country"
    named = sorted(f"{COUNTRY_NAMES.get(code, code)} ({code})" for code in codes)
    return " or ".join(named)


def build(src: Path, dst: Path, journal: str = "") -> tuple[int, int, int]:
    # The threshold tables are read out of the CSV, so they belong to one build.
    # Cleared here rather than at import, so building twice in one process
    # cannot quote the first run's policy in the second run's headings.
    THRESHOLDS.clear()
    THRESHOLD_NUMBERS.clear()
    with src.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    raw_header, raw_body = rows[0], rows[1:]

    header, body_columns = [], []
    for index, name in enumerate(raw_header):
        if name in DROP:
            continue
        clean = RENAME.get(name, name.removeprefix("filter_"))
        header.append(clean)
        body_columns.append([row[index] for row in raw_body])

    # A threshold that is identical for everybody belongs in the glossary.
    constants: list[tuple[str, str]] = []
    keep = []
    for position, name in enumerate(header):
        values = set(body_columns[position])
        if name.endswith(THRESHOLD_SUFFIXES) and len(values) == 1:
            value = values.pop()
            constants.append((name, value))
            THRESHOLDS[name] = _readable(name, value)
            THRESHOLD_NUMBERS[name] = value
            continue
        keep.append(position)
    header = [header[i] for i in keep]
    body_columns = [body_columns[i] for i in keep]
    body = [[cast(column[row]) for column in body_columns] for row in range(len(raw_body))]

    # blocking_reason: the first dimension that actually excluded this person.
    verdict_at = {name: header.index(name) for name in VERDICTS_IN_ORDER if name in header}
    reasons = []
    for row in body:
        reasons.append(
            next(
                (
                    BLOCKING_REASONS[name]
                    for name, at in verdict_at.items()
                    if row[at] in EXCLUDING_VERDICTS
                ),
                None,
            )
            if verdict_at
            else None
        )
    at = header.index("recommend_for_reviewer") + 1 if "recommend_for_reviewer" in header else 0
    header.insert(at, "blocking_reason")
    for row, reason in zip(body, reasons, strict=True):
        row.insert(at, reason)

    # Verdicts move into plain words before anything is styled or written.
    for row in body:
        for position, value in enumerate(row):
            if isinstance(value, str) and value in VERDICT_TEXT:
                row[position] = VERDICT_TEXT[value]

    # A rule that measures something shows the measurement. The verdict it
    # replaces is kept alongside so the cell can still be coloured by it.
    verdicts: list[list[str | None]] = [[None] * len(header) for _ in body]
    for rule, measure in RULE_MEASURES.items():
        if rule not in header or measure not in header:
            continue
        rule_at, measure_at = header.index(rule), header.index(measure)
        for row, shadow in zip(body, verdicts, strict=True):
            if row[measure_at] is None:
                continue  # nothing measured — the word is all there is to say
            shadow[rule_at] = row[rule_at]
            row[rule_at] = row[measure_at]

    # The restricted list is policy, not something this script gets to know. Name
    # it from the journal's own configuration, and cross-check the CSV against it
    # so a policy that has moved on cannot leave a workbook claiming the old rule.
    if "seniority_minimum" in THRESHOLDS or "seniority_maximum" in THRESHOLDS:
        THRESHOLDS["seniority_band"] = seniority_band(
            THRESHOLDS.get("seniority_minimum", "0"), THRESHOLDS.get("seniority_maximum", "0")
        )

    restricted = restricted_countries(src, journal)
    # Spelled out for the heading. The CSV states the list too, as the codes the
    # run applied, and that is what the cross-check below reads — this is the
    # display form only.
    THRESHOLDS["restricted_country_countries"] = describe_countries(restricted)
    if restricted and "restricted_country" in header:
        # Read off the verdict rather than a separate boolean: the verdict is
        # the thing the workbook shows, so it is the thing that has to agree
        # with the policy. A run whose policy has since changed produces a file
        # that would state the old rule under the new heading, and refusing it
        # is better than publishing it.
        verdict = header.index("restricted_country")
        country = header.index("current_country")
        failed = {row[country] for row in body if row[verdict] == VERDICT_TEXT["FILTERED"]}
        listed = {row[country] for row in body if row[country] in restricted}
        if disagreement := failed.symmetric_difference(listed):
            raise SystemExit(
                "the CSV's restricted-country outcome disagrees with the policy on: "
                + ", ".join(sorted(disagreement))
            )

    if missing := missing_thresholds(header):
        raise SystemExit(
            "the CSV supplies no constant value for: "
            + ", ".join(missing)
            + " — a heading needs them to state its rule"
        )

    wb = Workbook()

    decision = wb.active
    decision.title = "decision"
    picked = [header.index(name) for name in DECISION_COLUMNS if name in header]
    decision_header = [header[i] for i in picked]
    decision_body = [[row[i] for i in picked] for row in body]
    decision_verdicts = [[shadow[i] for i in picked] for shadow in verdicts]
    decision.append(decision_header)
    for row in decision_body:
        decision.append(row)
    _finish(
        decision, decision_header, decision_body, decision_verdicts, freeze="A2", wide=("reasoning",)
    )

    audit = wb.create_sheet("audit")
    audit.append(header)
    for row in body:
        audit.append(row)
    _finish(audit, header, body, verdicts, freeze="A2", wide=("reasoning",))

    glossary = wb.create_sheet("columns")
    for title, text in HOW_TO_READ:
        glossary.append([title, "", text])
        glossary.cell(row=glossary.max_row, column=1).font = Font(bold=True)
    glossary.append(["dimension", "column", "meaning"])
    for cell in glossary[glossary.max_row]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="D9D9D9")
    for name in header:
        glossary.append([dimension_of(name), label_of(name), GLOSSARY.get(name, "(undocumented)")])
    if constants:
        glossary.append([])
        glossary.append(["thresholds", "", "Same for every candidate this run, so not shown as columns."])
        glossary.cell(row=glossary.max_row, column=1).font = Font(bold=True)
        for name, value in constants:
            glossary.append([dimension_of(name), label_of(name), f"= {value}"])
    for column, width in (("A", 24), ("B", 56), ("C", 100)):
        glossary.column_dimensions[column].width = width
    for row in glossary.iter_rows(min_row=1):
        row[2].alignment = Alignment(vertical="top", wrap_text=True)

    wb.active = 0
    wb.save(dst)
    return len(body), len(decision_header), len(header)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("csv", type=Path, help="a 5-shortlist/contact-list-audit.csv")
    parser.add_argument(
        "--journal",
        default="",
        help="journal slug for the policy behind the run; read from the case profile when omitted",
    )
    args = parser.parse_args(argv)
    dst = args.csv.with_suffix(".xlsx")
    rows, decision, audit = build(args.csv, dst, args.journal)
    print(f"{dst}: {rows} rows — decision {decision} columns, audit {audit} columns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
