"""The sanitised record of a manuscript: the only representation of a submission that may reach a model."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from academia.core.text import as_text, title_hash

#: Fields allowed out of the manuscript. Anything else stays in the PDF.
SANITIZED_FIELDS = ("title", "abstract", "keywords", "authors", "journal", "year", "references")


@dataclass
class ManuscriptAuthor:
    name: str
    affiliation: str = ""
    country: str = ""
    orcid: str = ""


@dataclass
class Sanitized:
    """The only representation of a submission that may reach a model."""

    title: str
    abstract: str
    keywords: list[str] = field(default_factory=list)
    authors: list[ManuscriptAuthor] = field(default_factory=list)
    journal: str = ""
    year: int = 0
    reference_titles: list[str] = field(default_factory=list)
    reference_dois: list[str] = field(default_factory=list)

    @property
    def title_hash(self) -> str:
        return title_hash(self.title)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "abstract": self.abstract,
            "keywords": self.keywords,
            "authors": [asdict(a) for a in self.authors],
            "journal": self.journal,
            "year": self.year,
            "reference_titles": self.reference_titles,
            "reference_dois": self.reference_dois,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Sanitized:
        return cls(
            title=as_text(data.get("title")),
            abstract=as_text(data.get("abstract")),
            keywords=[as_text(k) for k in data.get("keywords") or []],
            authors=[
                ManuscriptAuthor(
                    name=as_text(a.get("name")),
                    affiliation=as_text(a.get("affiliation")),
                    country=as_text(a.get("country")).upper(),
                    orcid=as_text(a.get("orcid")),
                )
                for a in data.get("authors") or []
            ],
            journal=as_text(data.get("journal")),
            year=int(data.get("year") or 0),
            reference_titles=[as_text(t) for t in data.get("reference_titles") or []],
            reference_dois=[as_text(d) for d in data.get("reference_dois") or []],
        )
