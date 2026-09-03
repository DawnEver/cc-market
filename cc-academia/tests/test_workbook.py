"""The deliverable workbook: a reader who has not seen the pipeline must be able to use it.

Which means the sheet may not carry pipeline vocabulary, and every rule it states
has to be the rule the run actually applied — so the thresholds and the
restricted-country list are read from the run and from the policy, never frozen
into the code.
"""

from __future__ import annotations

import csv
from pathlib import Path

import openpyxl
import pytest

from academia.reviewer import workbook as script

#: The audit CSV as a run writes it: identity, the decision, then one verdict
#: column per rule with that rule's own facts named after it.
HEADER = [
    "rank",
    "reviewer",
    "person_id",
    "email",
    "institution",
    "current_country",
    "profile_url",
    "recommendation",
    "filter_coi",
    "filter_coi_severity",
    "filter_restricted_country",
    "filter_restricted_country_current",
    "filter_restricted_country_countries",
    "filter_related_journals",
    "filter_related_journals_count",
    "filter_related_journals_minimum",
    "filter_details",
]


def row(country: str, banned: str, coi: str, journals: str) -> list[str]:
    return [
        "1",
        "A Reviewer",
        "person-1",
        "a@uni.edu",
        "Some Uni",
        country,
        "https://orcid.org/0000-0002-1825-0097",
        "do_not_invite",
        coi,
        {"CLEAR": "0", "REVIEW": "1"}.get(coi, "2"),
        "FILTERED" if banned == "1" else "PASS",
        country,
        "IN, IR",
        "PASS" if int(journals) >= 3 else "FILTERED",
        journals,
        "3",
        "a sentence per rule",
    ]


def write_csv(tmp_path: Path, *rows: list[str], slug: str = "tte") -> Path:
    case = tmp_path / "ongoing" / f"{slug}-case"
    (case / "1-manuscript").mkdir(parents=True)
    (case / "1-manuscript" / "paper_profile.json").write_text(
        f'{{"journal": "{slug}"}}', encoding="utf-8"
    )
    shortlist = case / "5-shortlist"
    shortlist.mkdir()
    src = shortlist / "contact-list-audit.csv"
    # Written through csv, because a run does: the restricted-country list is
    # a single cell holding "IN, IR", and joining on commas silently shifted
    # every column after it.
    with src.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator=chr(10))
        writer.writerow(HEADER)
        writer.writerows(rows)
    return src


def retune(src: Path, **columns) -> None:
    """Rewrite a column in every row, the way a different policy would."""
    with src.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    for name, values in columns.items():
        at = rows[0].index(name)
        for line, value in zip(rows[1:], values, strict=True):
            line[at] = value
    with src.open("w", encoding="utf-8-sig", newline="") as handle:
        csv.writer(handle, lineterminator=chr(10)).writerows(rows)


def test_the_restricted_list_comes_from_the_journal_policy(tmp_path):
    src = write_csv(tmp_path, row("IN", "1", "CLEAR", "4"), row("CN", "0", "CLEAR", "4"))

    script.build(src, src.with_suffix(".xlsx"))
    heading = [c.value for c in openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"][1]]

    # Iran restricts nobody in this file; the heading still names it, because the
    # heading states the rule rather than what happened to fire.
    assert "Rule: not working in India (IN) or Iran (IR)" in heading


def test_a_csv_that_contradicts_the_policy_is_refused(tmp_path):
    # China is not restricted for TTE, so a row flagged as restricted means the
    # policy has moved since the run and the workbook would state the wrong rule.
    src = write_csv(tmp_path, row("CN", "1", "CLEAR", "4"))

    with pytest.raises(SystemExit, match="disagrees with the policy"):
        script.build(src, src.with_suffix(".xlsx"))


def test_the_threshold_in_a_heading_is_read_from_the_run(tmp_path):
    src = write_csv(tmp_path, row("CN", "0", "CLEAR", "4"))
    retune(src, filter_related_journals_minimum=["5"])

    script.build(src, src.with_suffix(".xlsx"))
    heading = [c.value for c in openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"][1]]

    assert "Rule: related journal papers ≥ 5" in heading


def test_a_heading_never_renders_an_unresolved_placeholder(tmp_path):
    src = write_csv(tmp_path, row("CN", "0", "CLEAR", "4"), row("CN", "0", "CLEAR", "2"))
    # Two different minima: the column is no longer a constant, so no threshold
    # can be quoted and the run must stop rather than print "{...}" in a heading.
    retune(src, filter_related_journals_minimum=["3", "4"])

    with pytest.raises(SystemExit, match="related_journals_minimum"):
        script.build(src, src.with_suffix(".xlsx"))


def test_no_pipeline_vocabulary_reaches_the_workbook(tmp_path):
    src = write_csv(tmp_path, row("IN", "1", "CLEAR", "4"), row("CN", "0", "FILTERED", "1"))

    script.build(src, src.with_suffix(".xlsx"))
    book = openpyxl.load_workbook(src.with_suffix(".xlsx"))
    seen = {
        str(cell.value)
        for sheet in book
        for line in sheet.iter_rows()
        for cell in line
        if cell.value is not None
    }

    assert not seen & {"PASS", "FILTERED", "VERIFY", "PREFERENCE_MISSED", "CLEAR"}
    assert not any(text.startswith("filter_") for text in seen)
    assert "person_id" not in seen


def test_a_quantifiable_rule_shows_its_number_and_the_verdict_only_colours_it(tmp_path):
    src = write_csv(tmp_path, row("CN", "0", "CLEAR", "4"), row("CN", "0", "CLEAR", "1"))

    script.build(src, src.with_suffix(".xlsx"))
    sheet = openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"]
    heading = [c.value for c in sheet[1]]
    at = heading.index("Rule: related journal papers ≥ 3")
    cells = [line[at] for line in sheet.iter_rows(min_row=2)]

    assert [cell.value for cell in cells] == [4, 1]
    assert cells[0].font.color.rgb.endswith("0B6B2E")
    assert cells[1].font.color.rgb.endswith("9C0006")


def test_why_not_recommended_is_a_sentence_not_a_field_name(tmp_path):
    src = write_csv(tmp_path, row("IN", "1", "CLEAR", "4"))

    script.build(src, src.with_suffix(".xlsx"))
    sheet = openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"]
    at = [c.value for c in sheet[1]].index("Why not recommended")

    assert sheet.cell(row=2, column=at + 1).value == "Works in a restricted country"


def test_the_link_column_is_clickable_and_only_where_there_is_a_link(tmp_path):
    src = write_csv(tmp_path, row("CN", "0", "CLEAR", "4"), row("CN", "0", "CLEAR", "4"))
    # Nobody's link resolved on the second row: an empty cell, not a hyperlink
    # to the empty string.
    retune(src, profile_url=["https://orcid.org/0000-0002-1825-0097", ""])

    script.build(src, src.with_suffix(".xlsx"))
    sheet = openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"]
    at = [c.value for c in sheet[1]].index("Homepage or paper") + 1

    assert sheet.cell(row=2, column=at).hyperlink.target == "https://orcid.org/0000-0002-1825-0097"
    assert sheet.cell(row=3, column=at).hyperlink is None


def test_building_twice_does_not_carry_the_first_policy_into_the_second(tmp_path):
    first = write_csv(tmp_path / "a", row("CN", "0", "CLEAR", "4"))
    second = write_csv(tmp_path / "b", row("CN", "0", "CLEAR", "9"))
    retune(second, filter_related_journals_minimum=["7"])

    script.build(first, first.with_suffix(".xlsx"))
    script.build(second, second.with_suffix(".xlsx"))
    heading = [c.value for c in openpyxl.load_workbook(second.with_suffix(".xlsx"))["decision"][1]]

    assert "Rule: related journal papers ≥ 7" in heading


def test_a_conflict_marked_for_review_is_not_a_blocking_reason(tmp_path):
    """Two live TTE candidates read "Check first" while the blocking-reason
    column said a conflict had excluded them. It had not: a REVIEW-level
    conflict asks for a human. Anyone filtering that column for blanks to find
    who is still in play lost them."""
    src = write_csv(tmp_path, row("CN", "0", "REVIEW", "4"), row("CN", "0", "BLOCK", "4"))

    script.build(src, src.with_suffix(".xlsx"))
    sheet = openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"]
    at = [c.value for c in sheet[1]].index("Why not recommended") + 1

    assert sheet.cell(row=2, column=at).value is None
    assert sheet.cell(row=3, column=at).value == "Conflict of interest with the authors"


def test_each_rule_gets_exactly_one_verdict_column(tmp_path):
    """The decision sheet lists rules, and a rule appears once.

    The conflict rule was named both on its own and again as the head of the
    rule order, so the sheet carried two identical headings.
    """
    src = write_csv(tmp_path, row("CN", "0", "CLEAR", "4"))

    script.build(src, src.with_suffix(".xlsx"))
    heading = [c.value for c in openpyxl.load_workbook(src.with_suffix(".xlsx"))["decision"][1]]

    assert len(heading) == len(set(heading))
