"""Output language for human-readable literature-review artifacts.

The workspace picks one language (``workspace.toml`` → ``[output] language``);
prose switches, while machine-readable structure and bibliographic identity stay
as they are, so downstream parsing, export and citation never see a difference.
"""

from __future__ import annotations

_NAMES = {
    "en": "English",
    "zh": "Simplified Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-hans": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "zh-hant": "Traditional Chinese",
}


def language_name(tag: str) -> str:
    """Human name for a BCP 47 tag; unknown tags are passed through verbatim."""
    return _NAMES.get(tag.strip().lower(), tag.strip())


def language_instruction(tag: str, *, json_output: bool = False) -> str:
    """System-prompt suffix for a non-English output language; empty for English."""
    name = language_name(tag)
    if not name or name == "English":
        return ""
    keys = (
        " Keep every JSON key and every enum value (e.g. verdict, research_use.type) exactly as specified in English;"
        " translate only free-text values."
        if json_output
        else ""
    )
    return (
        f"\n\nWrite all prose in {name}.{keys}"
        " Keep paper titles, author names, venues, DOIs and citation identifiers in their original form."
    )
