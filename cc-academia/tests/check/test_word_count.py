"""word-count: texcount parsing, main.tex discovery and the CLI (texcount replaced by a stub)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from academia.check.words import (
    find_main_tex,
    fmt,
    format_table,
    parse_texcount,
    target_line,
    tokenize,
)

from .helpers import run_cli
from .texcount_fixture import (
    CHAPTER_FIXTURE,
    EXPECTED_CHAPTER_SECTIONS,
    EXPECTED_CHAPTER_TOTAL,
    EXPECTED_SECTIONS,
    EXPECTED_TOTAL,
    FIXTURE,
)

STUB = Path(__file__).with_name("stub_texcount.py")
STUB_CMD = f'"{sys.executable}" "{STUB}"'


@pytest.fixture()
def project(tmp_path):
    (tmp_path / "main.tex").write_text("\\documentclass{article}\n", encoding="utf-8")
    return tmp_path


def test_parse_texcount_per_section_sums_and_grand_total():
    r = parse_texcount(FIXTURE)
    assert r["sections"] == EXPECTED_SECTIONS
    assert r["total"] == EXPECTED_TOTAL


def test_parse_texcount_handles_crlf():
    r = parse_texcount(FIXTURE.replace("\n", "\r\n"))
    assert r["sections"] == EXPECTED_SECTIONS
    assert r["total"] == EXPECTED_TOTAL


def test_parse_texcount_chapter_style_falls_back_to_per_file_breakdown():
    r = parse_texcount(CHAPTER_FIXTURE)
    assert r["sections"] == EXPECTED_CHAPTER_SECTIONS
    assert r["total"] == EXPECTED_CHAPTER_TOTAL


def test_parse_texcount_fails_clearly_without_sum_count():
    with pytest.raises(ValueError, match="Sum count"):
        parse_texcount("File: main.tex\nWords in text: 3\n")


def test_find_main_tex_at_the_root(project):
    assert find_main_tex(project) == {"dir": str(project.resolve()), "main": "main.tex"}


def test_find_main_tex_single_depth_1_subdirectory(tmp_path):
    sub = tmp_path / "chapter_1"
    sub.mkdir()
    (sub / "main.tex").write_text("", encoding="utf-8")
    assert find_main_tex(tmp_path) == {"dir": str(sub.resolve()), "main": "main.tex"}


def test_find_main_tex_ambiguous_candidates_are_listed(tmp_path):
    for d in ("a", "b"):
        (tmp_path / d).mkdir()
        (tmp_path / d / "main.tex").write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match=r"(?s)multiple main\.tex.*a.*b"):
        find_main_tex(tmp_path)


def test_find_main_tex_missing_main_tex(tmp_path):
    with pytest.raises(ValueError, match=r"no main\.tex found"):
        find_main_tex(tmp_path)


def test_find_main_tex_explicit_file_path(project):
    assert find_main_tex(project / "main.tex") == {
        "dir": str(project.resolve()),
        "main": "main.tex",
    }


def test_cli_table_with_sections_total_and_target(project, capsys, monkeypatch):
    code, out, err = run_cli(
        ["word-count", "--texcount", STUB_CMD, "--target", "8000"], project, capsys, monkeypatch
    )
    assert code == 0, err
    assert "Abstract" in out and "Aim" in out
    assert [
        line.split()[-1] for line in out.splitlines() if line.startswith(("Abstract", "Aim"))
    ] == ["8", "9"]
    assert (
        "Total (excl. references)" in out
        and out.split("Total (excl. references)")[1].split()[0] == "31"
    )
    assert "Target: 31 / 8,000 (0%)" in out


def test_cli_json_shape(project, capsys, monkeypatch):
    code, out, err = run_cli(
        ["word-count", "--json", "--texcount", STUB_CMD], project, capsys, monkeypatch
    )
    assert code == 0, err
    data = json.loads(out)
    assert data["main"] == "main.tex"
    assert data["total"] == 31
    assert data["sections"] == EXPECTED_SECTIONS


def test_cli_missing_texcount_exits_1_with_install_hint(project, capsys, monkeypatch):
    code, _, err = run_cli(
        ["word-count", "--texcount", "academia-write-no-such-binary-xyz"],
        project,
        capsys,
        monkeypatch,
    )
    assert code == 1
    assert "texcount not found" in err and "tlmgr install texcount" in err


def test_cli_no_main_tex_exits_2(tmp_path, capsys, monkeypatch):
    code, _, err = run_cli(["word-count"], tmp_path, capsys, monkeypatch)
    assert code == 2
    assert "no main.tex found" in err


def test_tokenize_honours_double_quotes():
    assert tokenize("texcount") == ["texcount"]
    assert tokenize(r'python "C:\path with spaces\stub.py"') == [
        "python",
        r"C:\path with spaces\stub.py",
    ]
    assert tokenize('"a b" c') == ["a b", "c"]


def test_format_table_and_target_line():
    t = format_table(EXPECTED_SECTIONS, EXPECTED_TOTAL)
    assert "Abstract" in t and "Total (excl. references)" in t
    assert target_line(1064, 5000) == "Target: 1,064 / 5,000 (21%)"
    assert fmt(8000) == "8,000"
