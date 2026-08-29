"""Per-manuscript workspace and resumable run state.

One directory per submission, numbered by stage so the state of a run is legible
from a file listing alone. Everything the model is allowed to see lives in
``1-manuscript/sanitized.json``; the raw PDF sits beside it and is never read by
any command that produces model-facing output.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from academia.core import paths
from academia.core.errors import UsageError
from academia.core.models import utcnow

STAGES = ("init", "profile", "search", "candidates", "enrich", "coi", "report")

RAW_PDF = "0-raw.pdf"
MANUSCRIPT_DIR = "1-manuscript"
SEARCH_DIR = "2-search"
CANDIDATE_DIR = "3-candidates"
AUDIT_DIR = "4-audit"
SHORTLIST_DIR = "5-shortlist"
STATE_FILE = "run_state.json"

SANITIZED = "sanitized.json"
PROFILE = "paper_profile.json"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    if not slug:
        raise UsageError("cannot derive a workspace slug from an empty name")
    return slug[:80]


def title_hash(title: str) -> str:
    """Manuscripts are keyed by hash so the database never stores their titles."""
    return hashlib.sha256((title or "").strip().lower().encode("utf-8")).hexdigest()[:32]


@dataclass
class RunState:
    slug: str
    stages: dict[str, str] = field(default_factory=dict)
    journal: str = ""
    ms_id: str = ""
    run_id: str = ""
    #: Fingerprint of the query set an editor approved. Bound to the queries
    #: themselves rather than to the act of approving, so editing them
    #: afterwards re-arms the gate.
    approved_queries: str = ""
    updated_at: str = ""

    def mark(self, stage: str, status: str = "done") -> None:
        if stage not in STAGES:
            raise UsageError(f"unknown stage: {stage}")
        self.stages[stage] = status
        self.updated_at = utcnow()

    def status(self, stage: str) -> str:
        return self.stages.get(stage, "pending")

    def next_stage(self) -> str:
        """The first stage that has not completed — what a resume should run."""
        for stage in STAGES:
            if self.stages.get(stage) != "done":
                return stage
        return "complete"

    def to_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "journal": self.journal,
            "ms_id": self.ms_id,
            "run_id": self.run_id,
            "approved_queries": self.approved_queries,
            "stages": self.stages,
            "updated_at": self.updated_at,
        }


@dataclass
class Workspace:
    root: Path
    slug: str

    @property
    def raw_pdf(self) -> Path:
        return self.root / RAW_PDF

    @property
    def manuscript_dir(self) -> Path:
        return self.root / MANUSCRIPT_DIR

    @property
    def sanitized_path(self) -> Path:
        return self.manuscript_dir / SANITIZED

    @property
    def profile_path(self) -> Path:
        return self.manuscript_dir / PROFILE

    @property
    def search_dir(self) -> Path:
        return self.root / SEARCH_DIR

    @property
    def candidate_dir(self) -> Path:
        return self.root / CANDIDATE_DIR

    @property
    def audit_dir(self) -> Path:
        return self.root / AUDIT_DIR

    @property
    def shortlist_dir(self) -> Path:
        return self.root / SHORTLIST_DIR

    @property
    def state_path(self) -> Path:
        return self.root / STATE_FILE

    def ensure(self) -> Workspace:
        for directory in (
            self.root,
            self.manuscript_dir,
            self.search_dir,
            self.candidate_dir,
            self.audit_dir,
            self.shortlist_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        return self

    # -- state -----------------------------------------------------------
    def load_state(self) -> RunState:
        if not self.state_path.exists():
            return RunState(slug=self.slug)
        data = json.loads(self.state_path.read_text(encoding="utf-8"))
        return RunState(
            slug=data.get("slug", self.slug),
            stages=data.get("stages", {}),
            journal=data.get("journal", ""),
            ms_id=data.get("ms_id", ""),
            run_id=data.get("run_id", ""),
            approved_queries=data.get("approved_queries", ""),
            updated_at=data.get("updated_at", ""),
        )

    def save_state(self, state: RunState) -> None:
        self.state_path.write_text(
            json.dumps(state.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    # -- artefacts -------------------------------------------------------
    def write_json(self, path: Path, payload: Any) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path

    def read_json(self, path: Path) -> Any:
        if not path.exists():
            raise UsageError(f"missing artefact: {path}")
        return json.loads(path.read_text(encoding="utf-8"))

    def write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return path

    def read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            raise UsageError(f"missing artefact: {path}")
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]


def workspace_root() -> Path:
    return paths.workspaces_root("reviewer-discovery")


def open_workspace(slug: str, *, create: bool = False) -> Workspace:
    clean = slugify(slug)
    workspace = Workspace(root=workspace_root() / clean, slug=clean)
    if create:
        return workspace.ensure()
    if not workspace.root.exists():
        raise UsageError(
            f"workspace not found: {workspace.root}\nRun: rev-disc init <pdf> --slug {clean}"
        )
    return workspace


def find_workspace_for(hash_of_title: str, *, excluding: str = "") -> str:
    """Slug of an existing workspace holding this manuscript, if any."""
    for slug in list_workspaces():
        if slug == excluding:
            continue
        path = workspace_root() / slug / MANUSCRIPT_DIR / SANITIZED
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if title_hash(str(data.get("title") or "")) == hash_of_title:
            return slug
    return ""



def list_workspaces() -> list[str]:
    root = workspace_root()
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir())
