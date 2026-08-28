"""Search phase: brief -> queries -> probe -> search -> dedupe -> screening packet."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from academia.litreview.state import mark_step

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> Path:
    _ensure(path.parent)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")
    return path


# ---------------------------------------------------------------------------
# 1. Search pipeline
# ---------------------------------------------------------------------------

# 1. Search pipeline
# ---------------------------------------------------------------------------

def run_search(
    topic_dir: Path,
    *,
    provider: str | list[str] | None = None,
    max_pages: int = 5,
    rows_per_page: int = 25,
    delay_seconds: float = 1.0,
    probe_only: bool = False,
    skip_probe: bool = False,
) -> dict[str, Any]:
    """Run end-to-end search: brief → queries → probe → search → normalize → dedupe → screening packet.

    Args:
        topic_dir: Path to workspaces/<slug>/
        provider: Provider name(s) (e.g. 'ieee', 'semantic_scholar', or ['ieee', 'arxiv']).
                  If None, reads providers from workspace.toml, falling back
                  to ['ieee_xplore'] when the file is absent.
        max_pages: Maximum pages per query for full search
        probe_only: If True, stop after probe (for query adjustment)
        skip_probe: If True, skip probe and go straight to full search

    Returns:
        Dict with keys: queries_path, probe_results, candidates_count, screening_packet_path
    """
    from academia.litreview.schema import load_data
    from academia.litreview.screen import write_screening_packet
    from academia.litreview.search import run_dedupe_rank, run_probe
    from academia.litreview.search import run_search as _run_search
    from academia.sources import get_source
    from academia.sources.base import PaperSource

    mark_step(topic_dir, "search", "in_progress")

    # Resolve providers: explicit arg > workspace.toml > default ['ieee']
    if provider is None:
        ws_path = topic_dir / "workspace.toml"
        if ws_path.exists():
            from academia.litreview.models import Workspace
            provider = Workspace.from_dict(load_data(ws_path)).providers
        else:
            provider = ["ieee_xplore"]
    if isinstance(provider, str):
        provider = [provider]

    prov_instances: list[PaperSource] = []
    for name in provider:
        try:
            prov_instances.append(get_source(name))
        except ValueError:
            print(f"  skip unknown provider: {name}")

    if not prov_instances:
        raise ValueError(f"No valid providers found from: {provider}")

    brief_path = topic_dir / "research_brief.toml"
    queries_path = topic_dir / "queries.toml"
    search_dir = _ensure(topic_dir / "search")

    if not brief_path.exists():
        raise FileNotFoundError(f"research_brief.toml not found in {topic_dir}. Run define step first.")

    result: dict[str, Any] = {
        "queries_path": str(queries_path),
        "probe_results": None,
        "candidates_count": 0,
        "screening_packet_path": None,
        "records_path": None,
        "providers_used": [p.name for p in prov_instances],
        "failures": [],
    }

    def _record_failure(provider_name: str, stage: str, error: Exception) -> None:
        result["failures"].append({"provider": provider_name, "stage": stage, "error": str(error)})
        print(f"    {stage} failed [{provider_name}]: {error}")

    # --- Probe (each provider) ---
    if not skip_probe:
        print("=== Probe ===")
        probe_dir = _ensure(search_dir / "probe")
        for prov in prov_instances:
            print(f"  Provider: {prov.name}")
            try:
                _ = run_probe(
                    queries_path=queries_path,
                    out_dir=search_dir,
                    provider=prov,
                    allow_unapproved_plan=True,
                )
            except Exception as exc:
                _record_failure(prov.name, "probe", exc)
        result["probe_results"] = str(probe_dir)

        if probe_only:
            mark_step(topic_dir, "search", "probed",
                      queries_path=str(queries_path),
                      probe_results=result["probe_results"])
            return result

        # Evaluate probe results per provider — advisory output for the agent
        # to review query breadth; full search does not gate on it. Paths are
        # surfaced in result['evaluation_paths'].
        from academia.litreview.query import evaluate_queries
        result["evaluation_paths"] = {}
        for prov in prov_instances:
            probe_results_file = probe_dir / prov.name / "probe_results.jsonl"
            if not probe_results_file.exists():
                continue
            try:
                eval_dir = search_dir / "evaluation" / prov.name
                evaluate_queries(
                    queries_path=queries_path,
                    probe_results_path=probe_results_file,
                    out_dir=eval_dir,
                )
                result["evaluation_paths"][prov.name] = str(eval_dir)
            except Exception as exc:
                _record_failure(prov.name, "evaluate", exc)

    # --- Full search (each provider; normalized records returned in memory) ---
    print("=== Full Search ===")
    all_candidates: list[dict[str, Any]] = []

    for prov in prov_instances:
        print(f"  Provider: {prov.name}")
        try:
            code, records = _run_search(
                queries_path=queries_path,
                out_dir=search_dir,
                provider=prov,
                max_pages=max_pages,
                rows_per_page=rows_per_page,
                delay_seconds=delay_seconds,
                allow_unapproved_plan=True,
            )
            if code != 0:
                _record_failure(prov.name, "search",
                                RuntimeError("one or more queries failed (see audit log)"))
            all_candidates.extend(records)
        except Exception as exc:
            _record_failure(prov.name, "search", exc)

    all_cand_path = search_dir / "all_candidates.jsonl"
    _write_jsonl(all_cand_path, all_candidates)

    # --- Deduplicate & rank ---
    print("=== Deduplicate & Rank ===")
    if all_candidates:
        run_dedupe_rank([all_cand_path], search_dir)

    result["records_path"] = str(search_dir / "candidates_ranked.jsonl")
    result["candidates_count"] = len(_read_jsonl(search_dir / "candidates_ranked.jsonl"))

    # --- Make screening packet ---
    print("=== Screening Packet ===")
    screening_dir = _ensure(topic_dir / "screening")
    records_path = Path(result["records_path"])
    if records_path.exists():
        write_screening_packet(records_path, screening_dir)
        result["screening_packet_path"] = str(screening_dir / "screening_packet.jsonl")

    mark_step(topic_dir, "search", "done",
              candidates_count=result["candidates_count"],
              screening_packet_path=result["screening_packet_path"],
              providers_used=result["providers_used"],
              failures=result["failures"])

    return result


# ---------------------------------------------------------------------------
# 2. Acquire pipeline
# ---------------------------------------------------------------------------

