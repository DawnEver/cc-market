"""Import rules of the layered architecture: dependencies point downward only.

L0 core; L1 documents, sources, store; L2 knowledge, check, figure; L3 the tasks read, write, review,
referee; L4 cli (L5 skills, agents and hooks are not Python). A module may import its own package and any
lower layer. The tasks never import each other: what they share moves down a layer. Within L2, knowledge is
the base the checks and the figure library read, so `check -> knowledge` and `figure -> knowledge` are the only
same-layer edges.
"""

from __future__ import annotations

import ast
from pathlib import Path

import academia

SRC = Path(academia.__file__).parent
LAYER = {
    "core": 0,
    "documents": 1,
    "sources": 1,
    "store": 1,
    "knowledge": 2,
    "check": 2,
    "figure": 2,
    "read": 3,
    "write": 3,
    "review": 3,
    "referee": 3,
    "cli": 4,
}
SIDEWAYS = {("check", "knowledge"), ("figure", "knowledge")}


def _imports(path: Path) -> list[tuple[int, str]]:
    """(line, top-level academia package) of every import in a module, including function-level ones."""
    out = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = (
                [node.module]
                if node.module != "academia"
                else [f"academia.{a.name}" for a in node.names]
            )
        else:
            continue
        for name in names:
            parts = name.split(".")
            if parts[0] == "academia" and len(parts) > 1 and parts[1] in LAYER:
                out.append((node.lineno, parts[1]))
    return out


def test_every_package_has_a_layer():
    packages = {p.name for p in SRC.iterdir() if p.is_dir() and (p / "__init__.py").exists()}
    assert packages <= set(LAYER), f"packages without a layer: {sorted(packages - set(LAYER))}"


def test_dependencies_point_downward_only():
    violations = []
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC)
        if len(rel.parts) < 2:
            continue  # academia/__init__.py: version only
        source = rel.parts[0]
        for line, target in _imports(path):
            if target == source or LAYER[target] < LAYER[source] or (source, target) in SIDEWAYS:
                continue
            kind = (
                "task imports a task"
                if LAYER[source] == LAYER[target] == 3
                else "upward or sideways"
            )
            violations.append(
                f"{rel.as_posix()}:{line}: {source} (L{LAYER[source]}) -> {target} (L{LAYER[target]}): {kind}"
            )
    assert violations == [], "\n".join(violations)
