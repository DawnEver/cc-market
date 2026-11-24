"""Data-driven prose checks. Every word list, threshold and choice comes from the effective configuration
(vocabulary, dimensions, units); this module holds only the mechanisms. Each hit names the rule id it
enforces and a severity:

* error — must rules; forbidden, spelling, hyphenate and collocation vocabulary
* warn  — principle rules; caution and canonical vocabulary
* info  — process rules (e.g. semantic line breaks)

Hits are candidates: the reviewer confirms or dismisses each (review own).
CLI: ``academia-write lint-prose [files] [--project DIR] [--json] [--min error|warn|info]``.
Exit codes: 0 no hit at or above --min (default warn), 1 hits, 2 usage or jurisdiction error.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

from academia.documents.tex import (
    captions,
    default_tex_files,
    prose_only,
    sentences,
    strip_code,
    text_lines,
)
from academia.knowledge.resolve import (
    Config,
    compile_term,
    defaults_note,
    dim,
    find_project,
    js_sub,
    resolve,
    source_list,
)

A = re.ASCII
CHECKS = [
    "vocabulary",
    "spelling",
    "relative-clause",
    "semicolon-chain",
    "sentence-length",
    "short-run",
    "opener-run",
    "pronoun-run",
    "self-reference",
    "conclusion-tense",
    "subject-verb-comma",
    "compound-subject",
    "slash-list",
    "unit-spacing",
    "caption-opening",
    "semantic-breaks",
    "footnote",
    "number-format",
    "abstract-format",
    "abbreviation",
    "display-paragraph",
]
#: Abbreviations IEEE allows undefined.
FREE_ABBREVIATIONS = {"IEEE", "SI", "AC", "DC"}
_ABBR = r"[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9-]*"
RANK = {"error": 3, "warn": 2, "info": 1}
CLASS_SEVERITY = {
    "forbidden": "error",
    "spelling": "error",
    "hyphenate": "error",
    "collocation": "error",
    "caution": "warn",
    "canonical": "warn",
}
KIND_SEVERITY = {"must": "error", "principle": "warn", "process": "info"}
# English function words: a compound before one of these is not a modifier (grammar, not style data).
FUNCTION_WORDS = set(
    [
        "and",
        "or",
        "but",
        "nor",
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "from",
        "by",
        "with",
        "as",
        "than",
        "that",
        "which",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "has",
        "have",
        "had",
        "the",
        "a",
        "an",
        "this",
        "these",
        "those",
        "its",
        "their",
        "it",
        "can",
        "may",
        "might",
        "will",
        "would",
        "should",
        "must",
        "not",
    ]
)
DETERMINERS = set(
    [
        "the",
        "a",
        "an",
        "its",
        "their",
        "this",
        "these",
        "those",
        "each",
        "most",
        "all",
        "some",
        "both",
        "more",
        "no",
        "every",
    ]
)
#: A restrictive relative clause on a noun; a comma-introduced "which" is the nonrestrictive tail.
RESTRICTIVE = re.compile(r"\b(that|who|whose)\b|(?<!,)(?<!, )\bwhich\b", re.I | A)
PRONOUNS = re.compile(r"^(Its|It|Their|They|This|These|Both)\b", A)
MACHINE_WHEN = {
    "sentence-start",
    "before-noun",
    "opener",
    "opener-run",
    "self-verb",
    "pair",
    "to-british",
    "to-american",
    "keep",
    "keep-ending",
}


def _rule_of(v: dict, rules: dict) -> str:
    return v["why"].split(":")[0].strip()


def part_of(section: str) -> str:
    """The manuscript part (resolve.PARTS, or ``caption``) a section title belongs to."""
    low = section.lower()
    for p in ("caption", "title", "abstract", "keywords", "introduction", "conclusion"):
        if low.startswith(p):
            return p
    return "body"


def _in_scope(scope: str, ctx: dict) -> bool:
    """Scope tokens (resolve.SCOPES): ``all``, a part, ``caption`` or ``prose``; ``!<token>`` excludes."""
    if not scope or scope == "all":
        return True
    part = part_of(ctx["section"])
    tokens = [s.strip().lower() for s in scope.split(",")]

    def hit(t: str) -> bool:
        return t == "all" or t == part or (t == "prose" and part != "caption")

    if any(hit(t[1:]) for t in tokens if t.startswith("!")):
        return False
    wanted = [t for t in tokens if not t.startswith("!")]
    return not wanted or any(hit(t) for t in wanted)


def _defines(text: str, end: int, replacement: str) -> bool:
    """True at a definition site: the match is followed, within its noun phrase, by "(<replacement>)"."""
    if "$" in replacement:
        return False
    tail = text[end : end + 60]
    return bool(re.match(r"^[\w\s-]{0,30}\(\s*" + re.escape(replacement) + r"\s*\)", tail, A))


def _strip_why(why: str) -> str:
    return re.sub(r"^[\w.-]+:\s*", "", why, count=1, flags=A)


@dataclass
class State:
    cfg: Config
    used: set[str] = field(default_factory=set)
    flagged: list[dict] = field(default_factory=list)
    connectives: list[str] = field(default_factory=list)
    opener_re: list[re.Pattern] = field(default_factory=list)
    self_verbs: list[str] = field(default_factory=list)
    pairs: dict[str, dict] = field(default_factory=dict)
    morph: dict[str, list[dict]] = field(default_factory=dict)
    keep: set[str] = field(default_factory=set)
    keep_end: list[str] = field(default_factory=list)
    slash_units: set[str] = field(default_factory=set)

    def D(self, dim_id: str) -> str:
        return dim(self.cfg, dim_id, self.used)

    def sev(self, rule_id: str) -> str:
        return KIND_SEVERITY.get(self.cfg.rules.get(rule_id, {}).get("kind", ""), "warn")


def prepare(cfg: Config) -> State:
    """Build the checker state once per configuration."""
    st = State(cfg)
    vocab = [v for v in cfg.vocabulary if v["content"] in ("prose", "data", "reference", "caption")]
    st.flagged = [
        {**v, "re": compile_term(v["term"]), "rule": _rule_of(v, cfg.rules)}
        for v in vocab
        if v["class"] not in ("phrase", "spelling") and v["when"] not in ("opener-run", "self-verb")
    ]
    st.connectives = [v["term"] for v in vocab if v["class"] == "phrase" and v["when"] == "opener"]
    st.opener_re = [compile_term(v["term"]) for v in vocab if v["when"] == "opener-run"]
    st.self_verbs = [
        re.sub(r"^/|/[a-z]*$", "", v["term"]) for v in vocab if v["when"] == "self-verb"
    ]
    sp = [v for v in vocab if v["class"] == "spelling"]
    st.pairs = {"british": {}, "american": {}}
    for v in sp:
        if v["when"] == "pair":
            st.pairs["british"][v["term"].lower()] = (v["replace"], v["why"])
            st.pairs["american"][v["replace"].lower()] = (v["term"], v["why"])
    st.morph = {
        "british": [v for v in sp if v["when"] == "to-british"],
        "american": [v for v in sp if v["when"] == "to-american"],
    }
    st.keep = {v["term"] for v in sp if v["when"] == "keep"}
    st.keep_end = [v["term"] for v in sp if v["when"] == "keep-ending"]
    st.slash_units = {u["unit"] for u in cfg.data["units"] if "/" in u["unit"]}
    return st


def foreign(word: str, variant: str, st: State) -> tuple[str, str] | None:
    """(suggestion, why) when ``word`` is the other variant's spelling, else None."""
    w = word.lower()
    hit = st.pairs[variant].get(w)
    if hit:
        return hit
    for v in st.morph[variant]:
        m = compile_term(v["term"]).search(w)
        if not m:
            continue
        base = m.group(1) + ("ize" if variant == "british" else "ise")
        if base in st.keep or any(base.endswith(k) for k in st.keep_end):
            continue
        body = v["term"][1 : v["term"].rindex("/")]
        return js_sub(re.compile(body, A), v["replace"], w), v["why"]
    return None


def _case_like(src: str, to: str) -> str:
    return to[0].upper() + to[1:] if src[0] == src[0].upper() else to


def spelling(src: str, variant: str, st: State) -> list[dict]:
    """Spelling hits [{line, word, suggest, why}] for words not in ``variant`` (british|american)."""
    out = []
    for tl in text_lines(src):
        for m in re.finditer(r"[A-Za-z]+", prose_only(tl["s"])):
            f = foreign(m.group(0), variant, st)
            if f:
                out.append(
                    {
                        "line": tl["line"],
                        "word": m.group(0),
                        "suggest": _case_like(m.group(0), f[0]),
                        "why": f[1],
                    }
                )
    return out


def _starts_with_connective(plain: str, connectives: list[str]) -> bool:
    return any(plain.startswith(c + ",") or plain.startswith(c + " ") for c in connectives)


def _drop_opener(plain: str, st: State) -> str:
    """Strip a leading opener ("In the X," / "First,") so the grammatical subject comes first."""
    opener = any(r.search(plain) for r in st.opener_re) or _starts_with_connective(
        plain, st.connectives
    )
    i = plain.find(",")
    return plain[i + 1 :].strip() if opener and i >= 0 else plain


def lint_source(src: str, file: str, st: State) -> list[dict]:
    """Lint one file's source with prepared state; returns hits."""
    cfg, D, sev = st.cfg, st.D, st.sev
    hits: list[dict] = []

    def add(line: int, rule: str, severity: str, message: str, text: str) -> None:
        hits.append(
            {
                "file": file,
                "line": line,
                "rule": rule,
                "severity": severity,
                "message": message,
                "text": text,
            }
        )

    units = sentences(src)
    caps = captions(src)
    max_w, min_w, run_n = (
        int(D("sentence.max-words")),
        int(D("sentence.min-words")),
        int(D("sentence.short-run")),
    )
    max_open = int(D("opener.max-run"))
    relative = D("sentence.relative-clause")
    avoid = D("connective.avoid")
    avoid_re = (
        re.compile(
            r"\b(" + "|".join(re.escape(x.strip()) for x in avoid.split(",")) + r")\b", re.I | A
        )
        if avoid != "none"
        else None
    )
    self_ref = D("self-reference").replace("-", " ")
    #: Document names in subject position; "either" allows "this paper" or the name of the format.
    self_names = [
        o.replace("-", " ")
        for o in cfg.dimensions["self-reference"]["options"].split(",")
        if o.startswith("this-")
    ]
    allowed = (
        {"this paper", "this digest", "this letter", "this article"}
        if self_ref == "either"
        else {self_ref}
    )
    tense = D("conclusion.tense")
    verbs = "|".join(st.self_verbs)

    def vocabulary(u: dict) -> None:
        for v in st.flagged:
            if not _in_scope(v["scope"], u):
                continue
            for m in v["re"].finditer(u["text"]):
                if v["when"] == "sentence-start" and m.start() != 0:
                    break
                if v["when"] == "before-noun":
                    nxt = re.match(r"^\s+([A-Za-z][\w-]*)", u["text"][m.end() :], A)
                    if not nxt or nxt.group(1).lower() in FUNCTION_WORDS:
                        continue
                if v["replace"] and _defines(u["text"], m.end(), v["replace"]):
                    continue
                repl = ""
                if v["replace"]:
                    repl = " -> " + re.sub(
                        r"\$(\d)",
                        lambda g, m=m: (
                            (m.group(int(g.group(1))) if int(g.group(1)) <= m.re.groups else None)
                            or ""
                        ),
                        v["replace"],
                    )
                cond = (
                    f" (when: {v['when']})" if v["when"] and v["when"] not in MACHINE_WHEN else ""
                )
                add(
                    u["line"],
                    v["rule"],
                    CLASS_SEVERITY[v["class"]],
                    f'"{m.group(0)}"{repl} [{v["class"]}, {v["origin"]["kind"]}]{cond}: {_strip_why(v["why"])}',
                    u["raw"],
                )

    prev_open, prev_pron, short_run = 0, "", 0
    for u in units:
        w = [t for t in u["plain"].split(" ") if t]
        vocabulary(u)
        if relative == "forbid" and re.search(r",\s*which\b", u["text"], re.I | A):
            add(
                u["line"],
                "sentence.relative-clause",
                sev("sentence.relative-clause"),
                '", which" tail: give the fact its own sentence (sentence.relative-clause = forbid)',
                u["raw"],
            )
        if relative != "allow":
            rm = RESTRICTIVE.search(u["text"])
            if rm:
                add(
                    u["line"],
                    "sentence.relative-clause",
                    sev("sentence.relative-clause"),
                    f'"{rm.group(0)}" clause on a noun: use an adjective, a prepositional phrase '
                    f"or a separate sentence (sentence.relative-clause = {relative})",
                    u["raw"],
                )
        if ";" in u["plain"]:
            add(
                u["line"],
                "sentence.no-semicolon-chain",
                sev("sentence.no-semicolon-chain"),
                "semicolon chain: give each step its own sentence",
                u["raw"],
            )
        if avoid_re:
            for am in avoid_re.finditer(u["text"]):
                add(
                    u["line"],
                    "sentence.no-contrast-join",
                    sev("sentence.no-contrast-join"),
                    f'"{am.group(0)}" is in connective.avoid ({avoid}): give each side its own sentence',
                    u["raw"],
                )
        if len(w) > max_w:
            add(
                u["line"],
                "sentence.max-words",
                sev("sentence.max-words"),
                f"{len(w)} words > {max_w}: split at a logical link",
                u["raw"],
            )
        short_run = short_run + 1 if len(w) < min_w else 0
        if short_run == run_n:
            add(
                u["line"],
                "sentence.short-run",
                sev("sentence.short-run"),
                f"{run_n} short sentence(s) in a row (< {min_w} words): merge or connect them",
                u["raw"],
            )
        decorated = (
            any(r.search(u["plain"]) for r in st.opener_re)
            and not _starts_with_connective(u["plain"], st.connectives)
            and "," in " ".join(w[:14])
        )
        prev_open = prev_open + 1 if decorated else 0
        if prev_open > max_open:
            add(
                u["line"],
                "sentence.opener-variety",
                sev("sentence.opener-variety"),
                f"{prev_open} phrase-plus-comma openings in a row (max {max_open})",
                u["raw"],
            )
        pm = PRONOUNS.match(u["plain"])
        pron = pm.group(0) if pm else ""
        if pron and pron == prev_pron:
            add(
                u["line"],
                "sentence.no-pronoun-run",
                sev("sentence.no-pronoun-run"),
                f'run of "{pron} ..." openers',
                u["raw"],
            )
        prev_pron = pron
        # Self-reference: another document name in subject position (sentence start).
        sm = re.match(r"^This (paper|article|work|study|digest|letter)\b", u["plain"], A)
        if sm and f"this {sm.group(1)}" not in allowed and f"this {sm.group(1)}" in self_names:
            want = " or ".join(f'"{re.sub("^t", "T", a, count=1)}"' for a in sorted(allowed))
            add(
                u["line"],
                "self-reference",
                sev("self-reference"),
                f'"This {sm.group(1)}" -> {want} (self-reference = {self_ref.replace(" ", "-")})',
                u["raw"],
            )
        if re.match(r"^Conclusion", u["section"], re.I) and verbs:
            if tense == "present-perfect" and re.search(
                rf"\bThis (paper|study|work|article|digest) ({verbs})\b", u["plain"], A
            ):
                add(
                    u["line"],
                    "conclusion.tense",
                    sev("conclusion.tense"),
                    'conclusion: "This paper has <verb>" (conclusion.tense = present-perfect)',
                    u["raw"],
                )
            if tense == "past" and re.search(
                rf"\bThis (paper|study|work|article|digest) has ({verbs})\b", u["plain"], A
            ):
                add(
                    u["line"],
                    "conclusion.tense",
                    sev("conclusion.tense"),
                    'conclusion: "This paper <past verb>" (conclusion.tense = past)',
                    u["raw"],
                )
        # Single comma between subject and verb.
        body = _drop_opener(u["plain"], st)
        sv = re.match(
            r"^([^,]+?\w\)?),\s+(is|are|was|were|has|have|had|can|will|would|might|may|should|must)\b",
            body,
            A,
        )
        if sv and not re.search(
            r"\b(which|who|whose|that|when|where|if|because|although|while)\b",
            sv.group(1),
            re.I | A,
        ):
            tail = " ".join(sv.group(1).split(" ")[-3:])
            add(
                u["line"],
                "grammar.subject-verb-comma",
                sev("grammar.subject-verb-comma"),
                f'single comma between subject and verb: "{tail}, {sv.group(2)}"',
                u["raw"],
            )
        # Compound subject with a singular verb.
        if not re.match(r"^(Both|Each|Every|Either|Neither)\b", body, A):
            toks = body.split(" ")
            for i in range(len(toks) - 1):
                t = toks[i]
                if re.fullmatch(r"are|were|have|can|could|may|might|will|would|should|must", t):
                    break
                # A verb-like token: is/has/was, or an -s word followed by a determiner or quantifier.
                singular = re.fullmatch(r"is|has|was", t) is not None or (
                    re.fullmatch(r"[a-z]{3,}s", t) is not None
                    and not t.endswith("ss")
                    and toks[i + 1] in DETERMINERS
                )
                if singular:
                    span = " ".join(toks[:i])
                    if (
                        re.search(r"\band\b", span)
                        and "," not in span
                        and not re.search(r"\bbetween\b", span)
                        and not re.match(r"^(Th(is|e) (paper|study|work))", span)
                    ):
                        head = " ".join(span.split(" ")[:6])
                        add(
                            u["line"],
                            "grammar.compound-subject-agreement",
                            sev("grammar.compound-subject-agreement"),
                            f'compound subject "{head} ..." with singular verb "{t}"',
                            u["raw"],
                        )
                    break
        # Slash-joined word lists.
        for m in re.finditer(
            r"(?<![\w/])([A-Za-z][\w-]*(?:/[A-Za-z][\w-]*)+)(?![\w/])", u["text"], A
        ):
            if m.group(1) not in st.slash_units and not m.group(1).startswith("http"):
                add(
                    u["line"],
                    "mech.no-slash-list",
                    sev("mech.no-slash-list"),
                    f'slash list "{m.group(1)}": write it out with "and" or "or"',
                    u["raw"],
                )
    # Semantic line breaks: two sentences starting on one source line.
    seen: dict[int, int] = {}
    for u in units:
        seen[u["line"]] = seen.get(u["line"], 0) + 1
    for line, n in seen.items():
        if n > 1:
            add(
                line,
                "mech.semantic-line-breaks",
                sev("mech.semantic-line-breaks"),
                f"{n} sentences start on this source line: one sentence per line",
                "",
            )
    # Captions: vocabulary in caption scope, and the opening word.
    for c in caps:
        vocabulary(c)
        first = re.match(r"^\S+", c["plain"])
        if (
            first
            and (re.fullmatch(r"A|An|The", first.group(0)) or re.match(r"^[a-z]", first.group(0)))
            and "ieee.caption-opening" in cfg.rules
        ):
            add(
                c["line"],
                "ieee.caption-opening",
                sev("ieee.caption-opening"),
                f'caption opens with "{first.group(0)}": no A/An/The, capitalise the first word',
                c["raw"],
            )
    # Unit and degree spacing, on the raw lines outside maths environments.
    for tl in text_lines(src):
        line, s = tl["line"], strip_code(tl["s"])
        for unit in cfg.data["units"]:
            lt = re.escape(unit["latex"])
            if unit["spacing"] == "none":
                m = re.search(rf"(\d+(?:\.\d+)?)(\s+|\\,|~){lt}", s, A)
                if m:
                    add(
                        line,
                        "mech.unit-spacing",
                        sev("mech.unit-spacing"),
                        f'no space before {unit["latex"]}: "{m.group(0)}"',
                        s.strip(),
                    )
            else:
                for m in re.finditer(rf"(?<![\w.])(\d+(?:\.\d+)?)( +|~|){lt}(?![A-Za-z0-9])", s, A):
                    add(
                        line,
                        "mech.unit-spacing",
                        sev("mech.unit-spacing"),
                        f'"{m.group(0)}" -> "{m.group(1)}\\,{unit["latex"]}" (thin space between number and unit)',
                        s.strip(),
                    )
    _source_checks(src, units, cfg, D, sev, add)
    variant = D("spelling.variant")
    if variant != "none":
        for h in spelling(src, variant, st):
            add(
                h["line"],
                "mech.spelling-variant",
                sev("mech.spelling-variant"),
                f"{h['word']} -> {h['suggest']} ({variant}; {_strip_why(h['why'])})",
                h["word"],
            )
    order = {k: i for i, k in enumerate(cfg.rules)}
    return sorted(hits, key=lambda h: (h["line"], order.get(h["rule"], 10**9)))


def _source_checks(src: str, units: list[dict], cfg: Config, D, sev, add) -> None:
    """Checks on the raw source: footnotes, IEEE number forms, abstract format, abbreviations, display paragraphs."""
    raw = src.splitlines()
    code = [re.sub(r"(?<!\\)%.*", "", ln) for ln in raw]
    if "ieee.no-footnotes" in cfg.rules:
        for i, ln in enumerate(code, 1):
            if re.search(r"\\footnote(?![A-Za-z])", ln):
                add(
                    i,
                    "ieee.no-footnotes",
                    sev("ieee.no-footnotes"),
                    "footnote: move its content into the running text",
                    raw[i - 1].strip(),
                )
    if "ieee.numbers" in cfg.rules:
        for u in units:
            for m in re.finditer(r"(?<![\w.])\.\d", u["text"], A):
                add(
                    u["line"],
                    "ieee.numbers",
                    sev("ieee.numbers"),
                    f'"{m.group(0)}": write a leading zero ("0{m.group(0)}")',
                    u["raw"],
                )
            for m in re.finditer(r"\bfrom\s+\d[\d.,]*\s*(?:-|--|–)\s*\d", u["text"], A):
                add(
                    u["line"],
                    "ieee.numbers",
                    sev("ieee.numbers"),
                    f'"{m.group(0)}": a range opened by "from" uses "to"',
                    u["raw"],
                )
    if "ieee.abstract-format" in cfg.rules:
        ab = [u for u in units if part_of(u["section"]) == "abstract"]
        for a, b in pairwise(ab):
            if any(not raw[k].strip() for k in range(a["line"], b["line"] - 1)):
                add(
                    b["line"],
                    "ieee.abstract-format",
                    sev("ieee.abstract-format"),
                    "the abstract has more than one paragraph: join it into one",
                    b["raw"],
                )
        wr = D("abstract.word-range")
        rng = re.fullmatch(r"(\d+)-(\d+)", wr or "")
        if ab and rng:
            n = sum(len([w for w in u["plain"].split(" ") if w]) for u in ab)
            lo, hi = int(rng.group(1)), int(rng.group(2))
            if not lo <= n <= hi:
                add(
                    ab[0]["line"],
                    "ieee.abstract-format",
                    sev("ieee.abstract-format"),
                    f"the abstract has {n} words; abstract.word-range is {wr}",
                    "",
                )
    if "ieee.abbreviations" in cfg.rules:
        body = [
            u
            for u in units
            if part_of(u["section"]) not in ("abstract", "title", "keywords", "caption")
        ]
        defined_at: dict[str, tuple[int, int]] = {}
        for k, u in enumerate(body):
            for m in re.finditer(rf"\(({_ABBR})s?\)", u["text"], A):
                defined_at.setdefault(m.group(1), (k, m.start()))
        for k, u in enumerate(body):
            for m in re.finditer(rf"(?<![\w(-])({_ABBR}?)s?(?![\w-])", u["text"], A):
                ab_ = m.group(1)
                d = defined_at.get(ab_)
                if ab_ in FREE_ABBREVIATIONS or not d or (k, m.start()) >= (d[0], d[1] - 1):
                    continue
                add(
                    u["line"],
                    "ieee.abbreviations",
                    sev("ieee.abbreviations"),
                    f'"{ab_}" is used before its definition later in this file: define it at first use',
                    u["raw"],
                )
    if "equation.paragraph-after-display" in cfg.rules:
        ends = re.compile(r"\\end\{(equation|align|gather|multline|eqnarray)\*?\}|^\s*\\\]")
        for i, ln in enumerate(code):
            if not ends.search(ln):
                continue
            j = i + 1
            while j < len(code) and not code[j].strip():
                j += 1
            if j > i + 1 and j < len(code) and re.match(r"\s*(where|with)\b", code[j], A):
                add(
                    j + 1,
                    "equation.paragraph-after-display",
                    sev("equation.paragraph-after-display"),
                    f'"{code[j].strip()[:20]}..." continues the equation: remove the blank line above it',
                    raw[j].strip(),
                )


def lint(
    src: str, file: str = "t.tex", project: Path | None = None, cfg: Config | None = None
) -> list[dict]:
    """Convenience: lint a source string against a project root (or common only)."""
    return lint_source(src, file, prepare(cfg or resolve(project)))


def run(args) -> int:
    """``academia-write lint-prose``."""
    if args.min not in RANK:
        print("lint-prose: --min takes error, warn or info", file=sys.stderr)
        return 2
    root = Path(args.project).resolve() if args.project else find_project()
    cfg = resolve(root)
    if cfg.errors:
        for e in cfg.errors:
            print(f"jurisdiction: {e}", file=sys.stderr)
        return 2
    files = [Path(f) for f in args.files] or default_tex_files(root or Path("."))
    if not files:
        print("lint-prose: no .tex files", file=sys.stderr)
        return 2
    st = prepare(cfg)
    hits = [
        h
        for f in files
        for h in lint_source(f.read_text(encoding="utf-8"), f.name, st)
        if RANK[h["severity"]] >= RANK[args.min]
    ]
    note = defaults_note(st.used)
    if args.json:
        print(
            json.dumps(
                {"project": str(root) if root else None, "defaults": sorted(st.used), "hits": hits},
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(
            f"sources: {source_list(cfg)}"
            + ("" if root else " (no .academia/profile.tsv found: common only)")
        )
        if note:
            print(note)
        for h in hits:
            print(
                f"{h['file']}:{h['line']}  [{h['severity']} {h['rule']}] {h['message']}"
                + (f"\n    {h['text'][:160]}" if h["text"] else "")
            )
        n = {s: sum(1 for h in hits if h["severity"] == s) for s in RANK}
        print(f"{len(hits)} hits ({n['error']} error, {n['warn']} warn, {n['info']} info)")
    return 1 if hits else 0
