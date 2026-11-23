"""Test helpers: temporary LaTeX projects and synthetic knowledge trees. Every sentence and number in the
write tests is synthetic; no manuscript text is copied here."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from academia.cli import write_main
from academia.knowledge.resolve import knowledge_root

RULE_HEAD = [
    "id",
    "content",
    "source",
    "kind",
    "scope",
    "check",
    "statement",
    "why",
    "good",
    "bad",
    "provenance",
]
DIM_HEAD = ["id", "content", "options", "unset_default", "owner", "why"]
VAL_HEAD = ["id", "value", "evidence"]
VOC_HEAD = ["term", "class", "replace", "when", "why", "source", "scope"]
#: The shipped preset (tests need one real preset; its name stays in knowledge/presets/ only).
PRESET_ID = sorted(p.name for p in (knowledge_root() / "presets").iterdir() if p.is_dir())[0]


def tsv(rows: list[list[str]]) -> str:
    return "\n".join("\t".join(r) for r in rows) + "\n"


def tmp_tree(files: dict[str, str | bytes] | None = None) -> Path:
    """Temp dir with the given files ({relative path: content})."""
    d = Path(tempfile.mkdtemp(prefix="academia-write-"))
    for rel, content in (files or {}).items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content, encoding="utf-8", newline="\n")
    return d


def cleanup(d: Path) -> None:
    shutil.rmtree(d, ignore_errors=True)


def profile(rows: list[list[str]]) -> str:
    """profile.tsv content: [[kind, id, value, evidence], ...]."""
    return tsv([["kind", "id", "value", "evidence"], *[[*r, *[""] * (4 - len(r))] for r in rows]])


def rule(
    rid: str, content: str, source: str, kind: str = "principle", check: str = "reviewer"
) -> list[str]:
    return [rid, content, source, kind, "all", check, "s", "w", "", "", "p"]


def knowledge_tree(extra: dict[str, str] | None = None) -> Path:
    """A minimal knowledge tree with one common rule and one preset-owned dimension; ``extra`` adds files."""
    return tmp_tree(
        {
            "common/prose/rules.tsv": tsv(
                [
                    RULE_HEAD,
                    rule("grammar.x", "prose", "common", "must"),
                    rule("style.y", "prose", "common"),
                ]
            ),
            "common/prose/dimensions.tsv": tsv(
                [
                    DIM_HEAD,
                    ["tone", "prose", "plain,ornate", "plain", "preset", "w"],
                    ["limit", "prose", "int:1-9,none", "none", "venue", "w"],
                ]
            ),
            "presets/me/prose/values.tsv": tsv([VAL_HEAD, ["tone", "ornate", "ruling 2026-01-01"]]),
            "venues/v1/prose/values.tsv": tsv([VAL_HEAD, ["limit", "5", "call for papers"]]),
            "fields/f1/prose/rules.tsv": tsv([RULE_HEAD, rule("f1.moves", "prose", "field")]),
            "fields/f2/prose/rules.tsv": tsv([RULE_HEAD, rule("f2.moves", "prose", "field")]),
            **(extra or {}),
        }
    )


def run_cli(args: list[str], cwd: Path, capsys, monkeypatch) -> tuple[int, str, str]:
    """Run ``academia-write`` in-process from ``cwd``; returns (exit code, stdout, stderr)."""
    monkeypatch.chdir(cwd)
    capsys.readouterr()
    try:
        code = write_main(args)
    except SystemExit as e:  # argparse usage errors
        code = int(e.code or 0)
    out = capsys.readouterr()
    return code, out.out, out.err


PYTHON = sys.executable
