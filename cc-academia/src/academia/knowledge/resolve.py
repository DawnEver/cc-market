"""Merge the knowledge sources a project names into one effective configuration.

Sources (common, venue, field, preset, project) are parallel: none overrides another. Each item keeps
its provenance (file:line). An item written in a source that does not own it is a jurisdiction error
naming where it belongs. Layout and schemas: ``knowledge/README.md``.

CLI: ``academia-write resolve [--project DIR] [--venue V] [--field F] [--preset P] [--json|--md|--criteria]``.
Exit codes: 0 ok, 1 jurisdiction errors, 2 usage error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from dataclasses import field as _field
from pathlib import Path
from typing import Any

from academia.core import paths

#: What a manuscript is made of: each source has one folder per object it speaks about.
OBJECTS = ["prose", "figure", "table", "data", "equation", "reference", "caption"]
#: Folders of a source that are not manuscript objects: ``policy`` is how a venue handles a submission.
AREAS = [*OBJECTS, "policy"]
#: Where in the manuscript an item applies (the ``scope`` column); ``body`` is every section other than these.
PARTS = ["title", "abstract", "keywords", "introduction", "body", "conclusion"]
#: Every scope token. Besides the parts: ``caption`` and ``prose`` (text outside captions), ``table``, the figure
#: kinds, and ``review-comment`` (a referee report). ``!<token>`` excludes; tokens are comma-separated.
SCOPES = [
    "all",
    *PARTS,
    "caption",
    "prose",
    "table",
    "data-plot",
    "schematic",
    "multi-panel",
    "review-comment",
]
KINDS = ["common", "venue", "field", "preset", "project"]
VOCAB_CLASSES = [
    "forbidden",
    "caution",
    "canonical",
    "hyphenate",
    "spelling",
    "collocation",
    "phrase",
]
RULE_KINDS = ["must", "principle", "process"]
#: Who applies a criterion: the author reviewing a draft, a reviewer reading someone else's manuscript, or both.
APPLIES = ["self", "peer", "both"]
FOLDER = {"venue": "venues", "field": "fields", "preset": "presets"}
HEADERS = {
    "rules": "id content source kind scope check statement why good bad provenance",
    "dimensions": "id content options unset_default owner why",
    "values": "id value evidence",
    "vocabulary": "term class replace when why source scope",
    "criteria": "id content source scope angle applies question why provenance",
    "profile": "kind id value evidence",
}
#: Rule-id namespaces that are language correctness: common only, never relaxed.
CORRECTNESS = re.compile(r"^(grammar|mech)\.")
PROJECT_DIR = (".academia",)


def knowledge_root() -> Path:
    return paths.knowledge_dir()


def _rel(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.as_posix()


def read_tsv(
    file: Path, expect: str | None = None, base: Path | None = None
) -> tuple[list[dict], list[str]]:
    """Rows of a TSV file keyed by its header; each row carries ``_at`` (file:line)."""
    base = base or knowledge_root()
    lines = re.split(r"\r?\n", Path(file).read_text(encoding="utf-8"))
    header = lines[0].split("\t")
    at = _rel(Path(file), Path(base))
    errors: list[str] = []
    if expect and " ".join(header) != HEADERS[expect]:
        errors.append(f'{at}:1: header must be "{HEADERS[expect].replace(" ", "<TAB>")}"')
    rows = []
    for i, line in enumerate(lines[1:]):
        if not line.strip():
            continue
        cells = line.split("\t")
        row = {"_at": f"{at}:{i + 2}"}
        for j, h in enumerate(header):
            row[h] = (cells[j] if j < len(cells) else "").strip()
        rows.append(row)
    return rows, errors


def find_project(start: Path | str | None = None) -> Path | None:
    """Nearest dir at or above ``start`` holding .academia/profile.tsv, else None."""
    d = Path(start or Path.cwd()).resolve()
    for cand in (d, *d.parents):
        if cand.joinpath(*PROJECT_DIR, "profile.tsv").exists():
            return cand
    return None


_JS_FLAGS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


def compile_term(term: str) -> re.Pattern:
    """A vocabulary term: ``/re/flags`` or a literal phrase (case-insensitive, word-bounded)."""
    m = re.match(r"^/(.*)/([a-z]*)$", term, re.DOTALL)
    if m:
        flags = re.ASCII
        for f in m.group(2):
            flags |= _JS_FLAGS.get(f, 0)
        return re.compile(m.group(1), flags)
    pre = r"(?<![\w-])" if re.match(r"^\w", term, re.ASCII) else ""
    post = r"(?![\w-])" if re.search(r"\w$", term, re.ASCII) else ""
    return re.compile(pre + re.escape(term) + post, re.IGNORECASE | re.ASCII)


def js_sub(pattern: re.Pattern | str, repl: str, text: str, count: int = 1) -> str:
    """``text.replace(regex, repl)`` with JavaScript ``$n`` group references in ``repl``."""
    rx = re.compile(pattern) if isinstance(pattern, str) else pattern

    def expand(m: re.Match) -> str:
        return re.sub(
            r"\$(\d)",
            lambda g: (
                m.group(int(g.group(1))) or "" if int(g.group(1)) <= rx.groups else g.group(0)
            ),
            repl,
        )

    return rx.sub(expand, text, count=count)


@dataclass
class Profile:
    venue: list[str] = _field(default_factory=list)
    field: list[str] = _field(default_factory=list)
    preset: list[str] = _field(default_factory=list)
    values: list[dict] = _field(default_factory=list)
    errors: list[str] = _field(default_factory=list)

    def names(self, kind: str) -> list[str]:
        return getattr(self, kind)


@dataclass
class Config:
    project: Path | None
    profile: Profile
    sources: list[dict]
    rules: dict[str, dict]
    criteria: dict[str, dict]
    dimensions: dict[str, dict]
    vocabulary: list[dict]
    templates: list[dict]
    data: dict[str, list[dict]]
    errors: list[str]

    def to_json(self) -> dict[str, Any]:
        def clean(o: Any) -> Any:
            if isinstance(o, Path):
                return str(o)
            if isinstance(o, dict):
                return {k: clean(v) for k, v in o.items()}
            if isinstance(o, list):
                return [clean(v) for v in o]
            if isinstance(o, Profile):
                return clean(o.__dict__)
            return o

        return clean(
            {
                "project": self.project,
                "profile": self.profile,
                "sources": self.sources,
                "rules": self.rules,
                "criteria": self.criteria,
                "dimensions": self.dimensions,
                "vocabulary": self.vocabulary,
                "templates": self.templates,
                "data": self.data,
                "errors": self.errors,
            }
        )


def _subdirs(d: Path) -> list[str]:
    return sorted(p.name for p in d.iterdir() if p.is_dir()) if d.exists() else []


def read_profile(
    root: Path | None, k: Path | None = None, extra: dict[str, list[str]] | None = None
) -> Profile:
    """A project's profile.tsv plus sources named on the command line (``extra``)."""
    k = k or knowledge_root()
    p = Profile()
    rows: list[dict] = []
    if root:
        rows, errors = read_tsv(
            Path(root).joinpath(*PROJECT_DIR, "profile.tsv"), "profile", Path(root)
        )
        p.errors.extend(errors)
    for kind, names in (extra or {}).items():
        rows += [
            {"kind": kind, "id": n, "value": "", "evidence": "", "_at": f"--{kind} {n}"}
            for n in names
        ]
    for r in rows:
        kind = r["kind"]
        if kind in ("venue", "field", "preset"):
            if not (k / FOLDER[kind] / r["id"]).exists():
                have = ", ".join(_subdirs(k / FOLDER[kind])) or "none"
                wf = {"field": "field-reading", "preset": "style-profiling"}.get(
                    kind, "ruling-capture"
                )
                p.errors.append(
                    f'{r["_at"]}: no {kind} source "{r["id"]}" in knowledge/{FOLDER[kind]}/ (have: {have}); '
                    f"create it with the {wf} workflow"
                )
            elif r["id"] not in p.names(kind):
                p.names(kind).append(r["id"])
        elif kind == "dimension":
            p.values.append(
                {"id": r["id"], "value": r["value"], "evidence": r["evidence"], "_at": r["_at"]}
            )
        else:
            p.errors.append(
                f'{r["_at"]}: unknown profile kind "{kind}" (venue, field, preset or dimension)'
            )
    return p


def _walk(d: Path) -> list[Path]:
    if not d.exists():
        return []
    out: list[Path] = []
    for f in sorted(d.iterdir(), key=lambda x: x.name):
        out += _walk(f) if f.is_dir() else [f]
    return out


def _check_option(d: dict, value: str) -> bool:
    o = d["options"]
    if o == "words":
        return value == "none" or bool(re.fullmatch(r"[A-Za-z][\w' -]*(,[A-Za-z][\w' -]*)*", value))
    if o == "range":
        return bool(re.fullmatch(r"\d+-\d+", value))
    for part in o.split(","):
        m = re.fullmatch(r"(int|num):([\d.]+)-([\d.]+)", part)
        if m:
            try:
                v = float(value)
            except ValueError:
                continue
            if (
                value != ""
                and float(m.group(2)) <= v <= float(m.group(3))
                and (m.group(1) == "num" or v.is_integer())
            ):
                return True
        elif part == value:
            return True
    return False


def _label(origin: dict) -> str:
    return (
        origin["kind"] if origin["kind"] == origin["name"] else f"{origin['kind']} {origin['name']}"
    )


def resolve(
    project: Path | str | None = None,
    *,
    knowledge: Path | None = None,
    extra: dict[str, list[str]] | None = None,
) -> Config:
    """Effective configuration for a project root (or common plus ``extra`` sources when None)."""
    k = Path(knowledge) if knowledge else knowledge_root()
    root = Path(project) if project else None
    profile = read_profile(root, k, extra)
    errors = list(profile.errors)
    sources = [{"kind": "common", "name": "common", "dir": k / "common"}]
    for kind in ("venue", "field", "preset"):
        sources += [
            {"kind": kind, "name": n, "dir": k / FOLDER[kind] / n} for n in profile.names(kind)
        ]
    rules: dict[str, dict] = {}
    criteria: dict[str, dict] = {}
    defs: dict[str, dict] = {}
    vocabulary: list[dict] = []
    templates: list[dict] = []
    values: list[dict] = []
    data: dict[str, list[dict]] = {"units": [], "palettes": []}
    plugin = k.parent

    def where(s: dict, content: str, file: str) -> str:
        src = "common" if s["kind"] == "common" else f"{FOLDER[s['kind']]}/{s['name']}"
        return f"knowledge/{src}/{content}/{file}"

    def scope_ok(item: dict, what: str) -> None:
        bad = scope_errors(item.get("scope", ""))
        if bad:
            errors.append(
                f'{item["_at"]}: {what} scope "{", ".join(bad)}" is not a scope ({", ".join(SCOPES)}); name the manuscript part it applies to'
            )

    def term_ok(v: dict) -> None:
        scope_ok(v, f'term "{v["term"]}"')
        try:
            compile_term(v["term"])
        except re.error as e:
            errors.append(f"{v['_at']}: bad term {v['term']}: {e}")

    for s in sources:
        for file in _walk(s["dir"]):
            rel = _rel(file, s["dir"])
            content, *rest = rel.split("/")
            name = "/".join(rest)
            if not rest:
                continue  # README.md, SOURCES.md, lens.toml
            if content not in AREAS:
                errors.append(
                    f'{rel}: "{content}" is not an object type or area ({", ".join(AREAS)})'
                )
                continue
            origin = {"kind": s["kind"], "name": s["name"]}
            if s["kind"] == "preset" and not (
                name == "values.tsv" or (name.startswith("vocabulary/") and name.endswith(".tsv"))
            ):
                errors.append(
                    f"{_rel(file, k)}: a preset holds dimension values and recommended phrases only; "
                    "a rule, criterion or template belongs in common, a venue or a field"
                )
                continue
            if name.startswith("templates/") and name.endswith(".md"):
                templates.append({"path": _rel(file, plugin), "content": content, **origin})
                continue
            if content == "policy" and name.endswith(".toml"):
                continue  # referee parameters, read by academia.referee.policy
            if name == "rules.tsv":
                rows, errs = read_tsv(file, "rules", k)
                errors.extend(errs)
                for r in rows:
                    at, rid = r["_at"], r["id"]
                    if r["source"] != s["kind"]:
                        errors.append(
                            f'{at}: rule {rid} says source "{r["source"]}" but sits in a {s["kind"]} source; move it to the {r["source"]} source or fix the column'
                        )
                    if r["content"] != content:
                        errors.append(
                            f'{at}: rule {rid} has content "{r["content"]}"; it belongs in {where(s, r["content"], "rules.tsv")}'
                        )
                    if r["kind"] not in RULE_KINDS:
                        errors.append(
                            f'{at}: rule {rid} kind "{r["kind"]}" must be {", ".join(RULE_KINDS)}'
                        )
                    if not re.fullmatch(r"lint:[\w-]+|reviewer|human", r["check"], re.ASCII):
                        errors.append(
                            f'{at}: rule {rid} check "{r["check"]}" must be lint:<check>, reviewer or human'
                        )
                    if CORRECTNESS.match(rid) and s["kind"] != "common":
                        errors.append(
                            f"{at}: {rid} is a correctness rule; it belongs in knowledge/common/{content}/rules.tsv and no source can relax it"
                        )
                    if s["kind"] == "venue" and r["kind"] != "must":
                        errors.append(
                            f'{at}: venue rule {rid} is "{r["kind"]}"; a venue holds format requirements (must) only, so a principle belongs in common or the field'
                        )
                    prev = rules.get(rid)
                    if prev:
                        tail = (
                            " (common); sources never override or relax another source: add a dimension or a new rule id instead"
                            if prev["origin"]["kind"] == "common"
                            else "; each fact lives in one place"
                        )
                        errors.append(f"{at}: rule {rid} is already defined at {prev['_at']}{tail}")
                        continue
                    scope_ok(r, f"rule {rid}")
                    rules[rid] = {**r, "origin": origin}
            elif name == "criteria.tsv":
                rows, errs = read_tsv(file, "criteria", k)
                errors.extend(errs)
                for c in rows:
                    at, cid = c["_at"], c["id"]
                    if c["source"] != s["kind"]:
                        errors.append(
                            f'{at}: criterion {cid} says source "{c["source"]}" but sits in a {s["kind"]} source'
                        )
                    if c["content"] != content:
                        errors.append(
                            f'{at}: criterion {cid} has content "{c["content"]}"; it belongs in {where(s, c["content"], "criteria.tsv")}'
                        )
                    if c["applies"] not in APPLIES:
                        errors.append(
                            f'{at}: criterion {cid} applies "{c["applies"]}" must be {", ".join(APPLIES)}'
                        )
                    if cid in criteria or cid in rules:
                        prev = criteria.get(cid) or rules[cid]
                        errors.append(
                            f"{at}: criterion {cid} is already defined at {prev['_at']}; each fact lives in one place"
                        )
                        continue
                    scope_ok(c, f"criterion {cid}")
                    criteria[cid] = {**c, "origin": origin}
            elif name == "dimensions.tsv":
                if s["kind"] != "common":
                    errors.append(
                        f"{_rel(file, k)}: dimension definitions live in knowledge/common/{content}/dimensions.tsv; a {s['kind']} source sets values in {content}/values.tsv"
                    )
                    continue
                rows, errs = read_tsv(file, "dimensions", k)
                errors.extend(errs)
                for d in rows:
                    if d["content"] != content:
                        errors.append(
                            f'{d["_at"]}: dimension {d["id"]} has content "{d["content"]}"; it belongs in knowledge/common/{d["content"]}/dimensions.tsv'
                        )
                    if d["owner"] not in KINDS:
                        errors.append(
                            f'{d["_at"]}: dimension {d["id"]} owner "{d["owner"]}" must be one of {", ".join(KINDS)}'
                        )
                    if d["id"] in defs:
                        errors.append(
                            f"{d['_at']}: dimension {d['id']} already defined at {defs[d['id']]['_at']}"
                        )
                    else:
                        defs[d["id"]] = d
            elif name == "values.tsv":
                rows, errs = read_tsv(file, "values", k)
                errors.extend(errs)
                values += [{**v, "content": content, "origin": origin} for v in rows]
            elif name.startswith("vocabulary/") and name.endswith(".tsv"):
                rows, errs = read_tsv(file, "vocabulary", k)
                errors.extend(errs)
                for v in rows:
                    if v["source"] != s["kind"]:
                        errors.append(
                            f'{v["_at"]}: term "{v["term"]}" says source "{v["source"]}" but sits in a {s["kind"]} source'
                        )
                    if v["class"] not in VOCAB_CLASSES:
                        errors.append(
                            f'{v["_at"]}: class "{v["class"]}" must be one of {", ".join(VOCAB_CLASSES)}'
                        )
                    if v["class"] == "spelling" and s["kind"] != "common":
                        errors.append(
                            f"{v['_at']}: spelling pairs are language correctness; they belong in knowledge/common/prose/vocabulary/spelling.tsv"
                        )
                    if s["kind"] == "preset" and v["class"] != "phrase":
                        errors.append(
                            f'{v["_at"]}: term "{v["term"]}" is {v["class"]}; a preset holds dimension values and recommended phrases only, '
                            "so a flagged term belongs in common, a field or the project vocabulary"
                        )
                        continue
                    term_ok(v)
                    vocabulary.append({**v, "content": content, "origin": origin})
            elif s["kind"] == "common" and content == "data" and name == "units.tsv":
                data["units"] = read_tsv(file, None, k)[0]
            elif s["kind"] == "common" and content == "figure" and name == "palettes.tsv":
                data["palettes"] = read_tsv(file, None, k)[0]
            elif not name.endswith(".md"):
                errors.append(
                    f"{_rel(file, k)}: unknown knowledge file; see knowledge/README.md for the five forms"
                )

    # Project files: vocabulary.tsv and optional rules.tsv (project is a source like any other).
    if root:
        pdir = root.joinpath(*PROJECT_DIR)
        origin = {"kind": "project", "name": "project"}
        if (pdir / "vocabulary.tsv").exists():
            rows, errs = read_tsv(pdir / "vocabulary.tsv", "vocabulary", root)
            errors.extend(errs)
            for v in rows:
                if v["source"] != "project":
                    errors.append(
                        f'{v["_at"]}: term "{v["term"]}" says source "{v["source"]}"; a project file holds project terms only'
                    )
                if v["class"] == "spelling":
                    errors.append(
                        f"{v['_at']}: spelling pairs belong in knowledge/common/prose/vocabulary/spelling.tsv"
                    )
                term_ok(v)
                vocabulary.append({**v, "content": "prose", "origin": origin})
        if (pdir / "rules.tsv").exists():
            rows, errs = read_tsv(pdir / "rules.tsv", "rules", root)
            errors.extend(errs)
            for r in rows:
                if CORRECTNESS.match(r["id"]):
                    errors.append(
                        f"{r['_at']}: {r['id']} is a correctness rule; it belongs in knowledge/common"
                    )
                if r["id"] in rules:
                    errors.append(
                        f"{r['_at']}: rule {r['id']} is already defined at {rules[r['id']]['_at']}; a project never overrides another source"
                    )
                    continue
                rules[r["id"]] = {**r, "origin": origin}
    for v in profile.values:
        values.append(
            {
                **v,
                "content": defs.get(v["id"], {}).get("content"),
                "origin": {"kind": "project", "name": "project"},
            }
        )

    # Dimension values: owner check, option check, conflicts between two sources of the same kind.
    dimensions: dict[str, dict] = {
        i: {
            "id": i,
            "content": d["content"],
            "owner": d["owner"],
            "options": d["options"],
            "why": d["why"],
            "value": d["unset_default"],
            "source": None,
            "evidence": "",
            "defaultUsed": True,
        }
        for i, d in defs.items()
    }
    for v in values:
        d = defs.get(v["id"])
        ok = v["origin"]["kind"]
        if not d:
            errors.append(
                f'{v["_at"]}: no dimension "{v["id"]}" is defined; define it in knowledge/common/<content>/dimensions.tsv first'
            )
            continue
        if d["owner"] != ok:
            place = (
                '<paper>/.academia/profile.tsv, kind "dimension"'
                if d["owner"] == "project"
                else f"knowledge/{FOLDER.get(d['owner'], 'common')}/<name>/{d['content']}/values.tsv"
            )
            errors.append(
                f"{v['_at']}: dimension {v['id']} is owned by {d['owner']}, not {ok}; set it in the {d['owner']} source ({place})"
            )
            continue
        if d["content"] != v["content"]:
            errors.append(
                f"{v['_at']}: dimension {v['id']} is a {d['content']} dimension; its value belongs in {d['content']}/values.tsv"
            )
        if not _check_option(d, v["value"]):
            errors.append(
                f'{v["_at"]}: {v["id"]}="{v["value"]}" is not one of the options "{d["options"]}"'
            )
            continue
        if not v["evidence"]:
            errors.append(
                f"{v['_at']}: {v['id']} has no evidence (a quoted corpus sentence or a dated user ruling)"
            )
        cur = dimensions[v["id"]]
        if cur["source"] and cur["value"] != v["value"]:
            errors.append(
                f'{v["_at"]}: {v["id"]}="{v["value"]}" conflicts with "{cur["value"]}" from {cur["source"]} ({cur["_at"]}); '
                f"two {ok} sources disagree — the project must name only one of them or the sources must agree"
            )
            continue
        cur.update(
            value=v["value"],
            source=_label(v["origin"]),
            evidence=v["evidence"],
            defaultUsed=False,
            _at=v["_at"],
        )

    # Vocabulary "why" names its rule; the rule must exist in the effective set. A flagged entry
    # (every class but phrase) must name one, so each lint hit carries a rule id.
    for v in vocabulary:
        rid = v["why"].split(":")[0].strip()
        if v["class"] != "phrase" and rid not in rules:
            errors.append(
                f'{v["_at"]}: term "{v["term"]}" is flagged but its why does not start with a rule id in the effective rules ("<rule id>: <remedy>")'
            )
        elif (
            re.fullmatch(r"[a-z][\w-]*\.[\w.-]+", rid, re.ASCII)
            and rid not in rules
            and rid not in defs
        ):
            errors.append(
                f'{v["_at"]}: term "{v["term"]}" names rule {rid}, which is not in the effective rules (add the source that defines it to the profile)'
            )

    if root:
        sources.append({"kind": "project", "name": "project", "dir": root.joinpath(*PROJECT_DIR)})
    return Config(
        root, profile, sources, rules, criteria, dimensions, vocabulary, templates, data, errors
    )


def dim(cfg: Config, dim_id: str, used: set[str] | None = None) -> str:
    """Dimension value, or the default; ``used`` collects ids whose default applied."""
    d = cfg.dimensions.get(dim_id)
    if d is None:
        raise KeyError(f"unknown dimension {dim_id}")
    if d["defaultUsed"] and used is not None:
        used.add(dim_id)
    return d["value"]


def defaults_note(used: set[str]) -> str:
    """One-line note listing the dimensions whose unset_default applied."""
    return f"default used: {', '.join(sorted(used))}" if used else ""


def source_list(cfg: Config) -> str:
    return ", ".join(
        s["kind"] if s["kind"] == s["name"] else f"{s['kind']}:{s['name']}" for s in cfg.sources
    )


def _origin(o: dict) -> str:
    return o["kind"] + (f" {o['name']}" if o["kind"] != o["name"] else "")


def criteria_markdown(
    cfg: Config, applies: str | None = None, angles: list[str] | None = None
) -> str:
    """Review criteria (form ``criterion``) as Markdown, filtered by who applies them and by angle."""
    rows = [
        c
        for c in cfg.criteria.values()
        if (not applies or c["applies"] in (applies, "both"))
        and (not angles or c["angle"] in angles)
    ]
    out = ["# Review criteria", "", f"Sources: {source_list(cfg)}"]
    for angle in dict.fromkeys(c["angle"] for c in rows):
        out += ["", f"## {angle}", ""]
        out += [
            f"- **{c['id']}** ({_origin(c['origin'])}; {c['content']}; {c['scope']}; {c['applies']}) {c['question']}"
            for c in rows
            if c["angle"] == angle
        ]
    return "\n".join(out)


def scope_errors(scope: str) -> list[str]:
    """Tokens of a ``scope`` cell that are not in SCOPES."""
    return [t for t in (x.strip().lstrip("!") for x in scope.split(",")) if t not in SCOPES]


def _scoped(item: dict, scope: str | None) -> bool:
    """An item applies to ``scope`` when it names it or ``all`` and does not exclude it."""
    if not scope:
        return True
    tokens = [t.strip() for t in item.get("scope", "").split(",")]
    return f"!{scope}" not in tokens and (
        scope in tokens or "all" in tokens or all(t.startswith("!") for t in tokens)
    )


#: Objects whose items an agent needs while working on each scope of the context index.
_TEXT = ["prose", "data", "equation", "reference"]
SCOPE_OBJECTS = {
    **{p: _TEXT for p in PARTS},
    "caption": ["caption", "data"],
    "table": ["table", "data"],
    "data-plot": ["figure", "caption", "data"],
    "schematic": ["figure", "caption"],
    "multi-panel": ["figure", "caption", "data"],
    "review-comment": ["prose"],
    "manuscript": OBJECTS,
}
#: Scopes ``resolve --scope`` accepts for the context index; ``manuscript`` is the whole paper
#: (a peer reviewer reads all of it through one angle).
INDEX_SCOPES = list(SCOPE_OBJECTS)
#: Scopes that take only the items naming them: ``all`` means running text, which a title,
#: the keywords and a referee report are not.
_EXPLICIT = ["title", "keywords", "review-comment"]


def _first_sentence(text: str) -> str:
    m = re.match(r"(.+?[.?!])(?=\s+[A-Z\"(]|$)", text.strip())
    return m.group(1) if m else text.strip()


def _in_index(item: dict, scope: str) -> bool:
    if item.get("content") not in SCOPE_OBJECTS[scope]:
        return False
    tokens = item.get("scope", "").split(",")
    if scope in _EXPLICIT:
        return scope in tokens
    if scope == "manuscript":
        return "review-comment" not in tokens
    if "review-comment" in tokens:
        return False
    return _scoped(item, scope)


def _dimensions_of(cfg: Config, item: dict) -> list[dict]:
    """Dimensions an item follows: the one with its id, or each named in its statement."""
    text = f"{item['id']} {item.get('statement', '')} {item.get('question', '')}"
    return [
        d
        for d in cfg.dimensions.values()
        if d["id"] == item["id"]
        or re.search(r"(?<![\w.-])" + re.escape(d["id"]) + r"(?![\w-])", text)
    ]


def context_index(
    cfg: Config,
    task: str,
    scope: str,
    applies: str | None = None,
    angles: list[str] | None = None,
) -> list[str]:
    """What an agent must judge for ``task`` on ``scope``: one line per item.

    ``write``: the rules checked by a reviewer or a human (lint rules surface only as lint hits).
    ``review``: the criteria ``applies`` (``self`` by default) of ``angles`` (one review
    agent reads one angle; all angles when None); then ``= id = value`` for
    the dimension values of the scope's objects. Details: ``explain <id>``.
    """
    if scope not in SCOPE_OBJECTS:
        raise ValueError(f"scope {scope!r} is not one of {', '.join(INDEX_SCOPES)}")
    if task not in ("write", "review"):
        raise ValueError(f"task {task!r} is not write or review")
    if task == "write" and scope == "manuscript":
        raise ValueError(
            "write works on one part at a time: give the part being edited as --scope "
            "(manuscript is for review, one angle at a time)"
        )
    out = [
        f"{r['id']} — {_first_sentence(r['statement'])}"
        for r in cfg.rules.values()
        if task == "write" and not r["check"].startswith("lint:") and _in_index(r, scope)
    ]
    if task == "review":
        who = applies or "self"
        out += [
            f"{c['id']} — {_first_sentence(c['question'])}"
            for c in cfg.criteria.values()
            if c["applies"] in (who, "both")
            and (not angles or c["angle"] in angles)
            and _in_index(c, scope)
        ]
    objects = SCOPE_OBJECTS[scope]
    out += [
        f"= {d['id']} = {d['value']}" + (" (default)" if d["defaultUsed"] else "")
        for d in cfg.dimensions.values()
        if d.get("content") in objects and d["value"] not in ("", "none")
    ]
    return out


def explain(cfg: Config, item_id: str) -> str:
    """Every field of the rule, criterion or dimension ``item_id``, with the dimension values it follows."""
    out: list[str] = []
    for kind, table in (("rule", cfg.rules), ("criterion", cfg.criteria)):
        it = table.get(item_id)
        if not it:
            continue
        out.append(f"{kind} {item_id} ({_origin(it['origin'])})")
        fields = (
            ["content", "kind", "scope", "check", "statement", "why", "good", "bad", "provenance"]
            if kind == "rule"
            else ["content", "scope", "angle", "applies", "question", "why", "provenance"]
        )
        out += [f"  {f}: {it[f]}" for f in fields if it.get(f)]
        out += [
            f"  dimension {d['id']} = {d['value']}"
            + (" (default)" if d["defaultUsed"] else f" ({d['source']})")
            for d in _dimensions_of(cfg, it)
        ]
    d = cfg.dimensions.get(item_id)
    if d:
        out.append(f"dimension {item_id}")
        out += [f"  {f}: {d[f]}" for f in ("content", "options", "owner", "why") if d.get(f)]
        src = "default used" if d["defaultUsed"] else d["source"]
        out.append(f"  value: {d['value']} ({src}; {d.get('evidence', '')})")
    if not out:
        raise KeyError(f"no rule, criterion or dimension {item_id}")
    return "\n".join(out)


def to_markdown(cfg: Config, scope: str | None = None) -> str:
    """Rules, dimensions, criteria and templates; ``scope`` keeps only rules and criteria naming that scope."""
    out = [
        "# Effective writing configuration",
        "",
        f"Project: {cfg.project or '(none: common only)'}",
        f"Sources: {source_list(cfg)}" + (f"; scope: {scope}" if scope else ""),
        "",
    ]
    out += ["## Dimensions", "", "| id | value | source | evidence |", "|---|---|---|---|"]
    for d in cfg.dimensions.values():
        src = "default used" if d["defaultUsed"] else d["source"]
        out.append(f"| {d['id']} | {d['value']} | {src} | {d['evidence'].replace('|', '/')} |")
    for c in AREAS:
        rs = [r for r in cfg.rules.values() if r.get("content") == c and _scoped(r, scope)]
        if not rs:
            continue
        out += ["", f"## Rules: {c}", ""]
        for r in rs:
            bad = f" Bad: {r['bad']}." if r.get("bad") else ""
            good = f" Good: {r['good']}." if r.get("good") else ""
            out.append(
                f"- **{r['id']}** ({_origin(r['origin'])}; {r['kind']}; {r['scope']}; {r['check']}) {r['statement']}{bad}{good}"
            )
    if scope is None and cfg.criteria:
        out += [
            "",
            criteria_markdown(cfg)
            .replace("# Review criteria", "## Review criteria", 1)
            .replace("\n## ", "\n### "),
        ]
    out += [
        "",
        "## Templates",
        "",
        *[f"- {t['path']} ({t['kind']} {t['name']})" for t in cfg.templates],
    ]
    proj = [v for v in cfg.vocabulary if v["origin"]["kind"] == "project"]
    if proj:
        out += ["", "## Project vocabulary", ""]
        for v in proj:
            rep = f" -> {v['replace']}" if v["replace"] else ""
            when = f"; when {v['when']}" if v["when"] else ""
            out.append(f"- {v['term']} ({v['class']}{rep}{when}) {v['why']}")
    return "\n".join(out)


def run(args) -> int:
    """``academia-write resolve``."""
    import sys

    extra = {k: getattr(args, k) or [] for k in ("venue", "field", "preset")}
    if args.project:
        root = Path(args.project).resolve()
        if not root.joinpath(*PROJECT_DIR, "profile.tsv").exists():
            print(
                f"resolve: {root} has no .academia/profile.tsv; create one (kind id value evidence) "
                "naming venues, fields and the preset",
                file=sys.stderr,
            )
            return 2
    else:
        root = find_project()
    cfg = resolve(root, extra=extra)
    if args.json:
        print(json.dumps(cfg.to_json(), indent=2, ensure_ascii=False))
    elif args.task:
        if not args.scope:
            print(
                f"resolve: --task needs --scope, one of {', '.join(INDEX_SCOPES)}", file=sys.stderr
            )
            return 2
        try:
            lines = context_index(cfg, args.task, args.scope, args.applies, args.angle)
        except ValueError as e:
            print(f"resolve: {e}", file=sys.stderr)
            return 2
        print(f"# {args.task} / {args.scope}; sources: {source_list(cfg)}; details: explain <id>")
        print("\n".join(lines))
    elif args.md:
        print(to_markdown(cfg, args.scope))
    elif args.criteria:
        print(criteria_markdown(cfg, args.applies, args.angle))
    else:
        print(f"project: {root or '(none: common only)'}")
        print(f"sources: {source_list(cfg)}")
        print(
            f"rules: {len(cfg.rules)}  criteria: {len(cfg.criteria)}  vocabulary: {len(cfg.vocabulary)}  templates: {len(cfg.templates)}"
        )
        for d in cfg.dimensions.values():
            print(
                f"  {d['id']} = {d['value']}  ({'default used' if d['defaultUsed'] else d['source']})"
            )
    for e in cfg.errors:
        print(f"jurisdiction: {e}", file=sys.stderr)
    return 1 if cfg.errors else 0


def run_explain(args) -> int:
    """``academia-write explain <id>``."""
    import sys

    root = Path(args.project).resolve() if args.project else find_project()
    cfg = resolve(root)
    try:
        print(explain(cfg, args.id))
    except KeyError as e:
        print(
            f"explain: {e.args[0]}; list ids with academia-write resolve --task write --scope <part>",
            file=sys.stderr,
        )
        return 2
    return 0
