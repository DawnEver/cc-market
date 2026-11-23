"""lint-table, check-data and page-budget. Table values, CSV data and numbers are synthetic."""

from __future__ import annotations

import re
import zlib

import pytest

from academia.check.numbers import check_registry, evaluate, hand_typed, numbers_tex, read_csv
from academia.check.pages import count_pages, pages_from_log
from academia.check.table import lint_tables
from academia.knowledge.resolve import resolve

from .helpers import cleanup, profile, run_cli, tmp_tree, tsv


# ---- lint-table ----
def table(rows):
    body = " \\\\\n".join(" & ".join(r) for r in rows)
    return f"\\begin{{tabular}}{{ll}}\n\\hline\n{body} \\\\\n\\hline\n\\end{{tabular}}\n"


def table_rules(rows, cfg=None):
    return [h["rule"] for h in lint_tables(table(rows), "t.tex", cfg or resolve(None))]


def test_lint_table_abbreviations_slashes_units_in_values_and_bracket_style():
    assert table_rules([["Stator OD [mm]", "180.0"]]) == ["table.full-names"]
    assert table_rules([["Slots / poles", "48 / 4"]]) == [
        "table.one-quantity-per-cell",
        "table.one-quantity-per-cell",
    ]
    assert table_rules([["Stator outer diameter", "180.0 mm"]]) == ["table.unit"]
    assert table_rules([["Stator outer diameter (mm)", "180.0"]]) == ["table.unit"]
    assert (
        table_rules([["Stator outer diameter [mm]", "180.0", "Maximum speed [r/min]", "8000"]])
        == []
    )


def test_lint_table_bracket_style_follows_the_dimension():
    d = tmp_tree({".academia/profile.tsv": profile([])})
    try:
        cfg = resolve(d)
        cfg.dimensions["table.unit-brackets"] = {
            **cfg.dimensions["table.unit-brackets"],
            "value": "parentheses",
            "defaultUsed": False,
        }
        assert table_rules([["Stator outer diameter [mm]", "180.0"]], cfg) == ["table.unit"]
        assert table_rules([["Stator outer diameter (mm)", "180.0"]], cfg) == []
    finally:
        cleanup(d)


# ---- check-data ----
CSV = "run,speed_rpm,total_W\na0,3000,1000.00\na90,3000,1500.00\nb1,3000,2000.00\nb2,3000,1940.00\nc1,3000,1600.00\n"
NUMBERS = [
    ["id", "value", "unit", "expr", "source", "round"],
    ["skew-gain", "0.5", "kW", "(a90.total_W - a0.total_W) / 1000", "data/run.csv", "1"],
    ["shape-share", "3", "%", "(b1.total_W - b2.total_W) / b1.total_W * 100", "data/run.csv", "0"],
    ["load-increase", "25", "%", "(b1.total_W / c1.total_W - 1) * 100", "data/run.csv", "0"],
]


def test_evaluate_arithmetic_precedence_and_errors():
    def look(n):
        return {"a.x": 2, "b.x": 3}[n]

    assert evaluate("a.x + b.x * 2", look) == 8
    assert evaluate("(a.x + b.x) * 2 / -1", look) == -10
    with pytest.raises(ValueError, match="unexpected end"):
        evaluate("a.x +", look)
    with pytest.raises(ValueError, match='trailing "; 1"'):
        evaluate("a.x ; 1", look)


def test_check_data_registry_numbers_tex_and_hand_typed_numbers(capsys, monkeypatch):
    d = tmp_tree(
        {
            "data/run.csv": CSV,
            ".academia/numbers.tsv": tsv(NUMBERS),
            ".academia/profile.tsv": profile([]),
            "Sections/a.tex": "The skew adds 0.5\\,kW. The shaping saves 3\\,\\% of the loss. It is 0.55\\,kW elsewhere.\n",
        }
    )
    try:
        assert read_csv(d / "data/run.csv")["rows"]["a0"]["total_W"] == "1000.00"
        res = check_registry(d)
        assert [(r["id"], r["ok"]) for r in res] == [
            ("skew-gain", True),
            ("shape-share", True),
            ("load-increase", True),
        ]
        tex = numbers_tex(res)
        assert "\\@namedef{ccval@skew-gain}{0.5\\,kW}" in tex
        assert "\\@namedef{ccval@shape-share}{3\\,\\%}" in tex
        assert "\\newcommand{\\val}" in tex and "\\num" not in tex, (
            "\\val never collides with siunitx \\num"
        )
        assert [
            h["id"] for h in hand_typed((d / "Sections/a.tex").read_text(encoding="utf-8"), res)
        ] == ["skew-gain", "shape-share"]
        code, out, _ = run_cli(["check-data", "--write"], d, capsys, monkeypatch)
        assert code == 1, "hand-typed numbers make the exit 1"
        assert '[error data.registry] "0.5\\,kW" -> \\val{skew-gain}' in out
        assert re.search(r"\\newcommand\{\\val\}", (d / "numbers.tex").read_text(encoding="utf-8"))
        (d / ".academia/numbers.tsv").write_text(
            tsv(
                [
                    NUMBERS[0],
                    ["skew-gain", "0.6", "kW", NUMBERS[1][3], "data/run.csv", "1"],
                    ["bad", "1", "W", "nope.total_W", "data/run.csv", "0"],
                ]
            ),
            encoding="utf-8",
        )
        bad = check_registry(d)
        assert bad[0]["ok"] is False
        assert bad[0]["rounded"] == "0.5"
        assert 'no row "nope"' in bad[1]["error"]
        assert (
            "numbers.tex not written"
            in run_cli(["check-data", "--write"], d, capsys, monkeypatch)[2]
        )
    finally:
        cleanup(d)


def test_check_data_missing_registry_teaches_its_schema(capsys, monkeypatch):
    d = tmp_tree({".academia/profile.tsv": profile([])})
    try:
        code, _, err = run_cli(["check-data"], d, capsys, monkeypatch)
        assert code == 2
        assert "columns id value unit expr source round" in err
    finally:
        cleanup(d)


# ---- page budget ----
def pdf(pages, compressed=0):
    objs = "".join(f"{i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n" for i in range(pages))
    hidden = b""
    if compressed:
        hidden = (
            b"9 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n"
            + zlib.compress(" ".join(["<< /Type /Page /Parent 2 0 R >>"] * compressed).encode())
            + b"\nendstream\nendobj\n"
        )
    head = f"%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count {pages + compressed} >> endobj\n{objs}"
    return head.encode() + hidden + b"%%EOF\n"


def test_count_pages_plain_and_compressed_pages_not_counted_log_fallback():
    assert count_pages(pdf(3)) == 3
    assert count_pages(pdf(2, 4)) == 6
    assert pages_from_log("Output written on main.pdf (6 pages, 2529534 bytes).") == 6
    assert pages_from_log("No pages of output.") is None


def test_page_budget_cli_over_the_venue_limit_exits_1_no_limit_reports_default(capsys, monkeypatch):
    d = tmp_tree({".academia/profile.tsv": profile([["venue", "iemdc-2027"]])})
    free = tmp_tree({})
    try:
        (d / "main.pdf").write_bytes(pdf(6))
        code, out, _ = run_cli(["page-budget"], d, capsys, monkeypatch)
        assert code == 1
        assert re.search(r"6 pages .* limit 5, references inside the limit", out)
        assert "1 page(s) over the limit" in out
        (d / "main.pdf").write_bytes(pdf(5))
        assert run_cli(["page-budget"], d, capsys, monkeypatch)[0] == 0
        (free / "main.pdf").write_bytes(pdf(9))
        code, out, _ = run_cli(["page-budget", str(free / "main.pdf")], free, capsys, monkeypatch)
        assert code == 0
        assert "default used: document.page-limit" in out
    finally:
        cleanup(d)
        cleanup(free)
