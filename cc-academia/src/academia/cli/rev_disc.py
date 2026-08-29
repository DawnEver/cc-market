"""``rev-disc`` — reviewer discovery for an associate editor.

Six stages, each resumable, each writing a numbered directory:

    init -> profile -> search -> candidates -> enrich -> coi -> report

Everything deterministic happens here; a model is only ever asked to phrase a
research summary, never to decide who is conflicted or who is qualified.
"""

from __future__ import annotations

import argparse
import shutil
from datetime import datetime
from pathlib import Path

from academia.core import log
from academia.core.errors import EXIT_OK, UsageError
from academia.core.models import stable_id
from academia.reviewer import coi as coi_module
from academia.reviewer import discover, geo, rank, report
from academia.reviewer import enrich as enrich_module
from academia.reviewer.policy import load_policy
from academia.reviewer.profile import (
    Profile,
    Sanitized,
    build_profile,
    ingest_pdf,
    load_sanitized,
    write_sanitized,
)
from academia.reviewer.workspace import open_workspace, slugify
from academia.store import db
from academia.store import repository as repo


def _now_year() -> int:
    return datetime.now().year


def _sources(names: list[str] | None):
    from academia.sources.ieee import IeeeXplore
    from academia.sources.openalex import OpenAlex

    registry = {"openalex": OpenAlex, "ieee": IeeeXplore}
    chosen = names or ["openalex", "ieee"]
    unknown = [n for n in chosen if n not in registry]
    if unknown:
        raise UsageError(f"unknown source(s): {', '.join(unknown)}")
    return [registry[name]() for name in chosen]


# --------------------------------------------------------------------- init


def run_init(args: argparse.Namespace) -> int:
    """Create the workspace and produce the sanitized record.

    This is the only command permitted to read the raw PDF. Everything
    downstream reads ``1-manuscript/sanitized.json``, which is what keeps the
    manuscript body out of any model context regardless of host.
    """
    if args.pdf:
        pdf = Path(args.pdf).expanduser().resolve()
        if not pdf.exists():
            raise UsageError(f"file not found: {pdf}")
        slug = slugify(args.slug or pdf.stem)
    else:
        if not args.title:
            raise UsageError("provide a PDF path, or --title with --abstract")
        pdf = None
        slug = slugify(args.slug or args.title)

    workspace = open_workspace(slug, create=True)

    if pdf is not None:
        if workspace.raw_pdf.resolve() != pdf:
            shutil.copy2(pdf, workspace.raw_pdf)
        sanitized = ingest_pdf(workspace.raw_pdf)
    else:
        sanitized = Sanitized(
            title=args.title,
            abstract=args.abstract or "",
            keywords=[k.strip() for k in (args.keywords or "").split(",") if k.strip()],
            journal=args.journal or "",
            year=args.year or _now_year(),
        )

    if args.journal:
        sanitized.journal = args.journal
    # A PDF carries no submission year, and a year of 0 would widen the
    # co-authorship window to everything ever published.
    sanitized.year = args.year or sanitized.year or _now_year()

    write_sanitized(workspace, sanitized)
    state = workspace.load_state()
    state.slug = slug
    state.journal = args.journal or sanitized.journal
    state.ms_id = stable_id("ms", sanitized.title_hash)
    state.mark("init")
    workspace.save_state(state)

    payload = {
        "slug": slug,
        "workspace": str(workspace.root),
        "ms_id": state.ms_id,
        "sanitized": str(workspace.sanitized_path),
        "next": "rev-disc profile --slug " + slug,
    }
    if args.json:
        log.emit(payload)
    else:
        log.info(f"workspace ready: {workspace.root}")
        log.info(f"  sanitized record: {workspace.sanitized_path}")
        log.info(f"  next: {payload['next']}")
    return EXIT_OK


# ------------------------------------------------------------------ profile


def run_profile(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    sanitized = load_sanitized(workspace)

    profile = build_profile(sanitized, manuscript_id=state.ms_id, journal=state.journal)
    workspace.write_json(workspace.profile_path, profile.to_dict())

    with db.session() as conn:
        repo.create_manuscript(
            conn,
            ms_id=profile.manuscript_id,
            journal=profile.journal,
            title_hash=profile.title_hash,
            origin_countries=profile.origin_countries,
        )
        for author in sanitized.authors:
            repo.add_manuscript_author(
                conn,
                profile.manuscript_id,
                name=author.name,
                affiliation=author.affiliation,
                country=author.country,
            )

    state.mark("profile")
    workspace.save_state(state)

    payload = {
        "manuscript_id": profile.manuscript_id,
        "topics": profile.primary_topics,
        "methods": profile.methods,
        "queries": [q.expression for q in profile.queries],
        "origin_countries": profile.origin_countries,
    }
    if args.json:
        log.emit(payload)
    else:
        log.info(f"topics : {', '.join(profile.primary_topics) or 'none extracted'}")
        log.info(f"methods: {', '.join(profile.methods) or 'none detected'}")
        log.info(f"origin : {', '.join(profile.origin_countries) or 'unknown'}")
        log.info(f"{len(profile.queries)} queries written to {workspace.profile_path}")
    return EXIT_OK


def _load_profile(workspace) -> Profile:
    return Profile.from_dict(workspace.read_json(workspace.profile_path))


# ------------------------------------------------------------------- search


def run_search(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    profile = _load_profile(workspace)

    outcome = discover.run_search(
        _sources(args.source),
        profile,
        max_pages=args.pages,
        per_page=args.per_page,
        year_from=args.year_from,
    )

    with db.session() as conn:
        stored = discover.store_papers(conn, outcome.papers)

    workspace.write_jsonl(
        workspace.search_dir / "papers.jsonl",
        [
            {
                "paper_id": p.paper_id,
                "title": p.title,
                "year": p.year,
                "doi": p.doi,
                "source": p.source,
                "authors": [a.name for a in p.authors],
            }
            for p in outcome.papers
        ],
    )
    workspace.write_json(
        workspace.search_dir / "summary.json",
        {"per_query": outcome.per_query, "failures": outcome.failures, "stored": stored},
    )

    state.mark("search")
    workspace.save_state(state)

    payload = {"papers": stored, "per_query": outcome.per_query, "failures": outcome.failures}
    if args.json:
        log.emit(payload)
    else:
        log.info(f"{stored} unique papers stored")
        for key, count in sorted(outcome.per_query.items()):
            log.detail(f"  {key}: {count}")
        for key, reason in outcome.failures.items():
            log.warn(f"  {key}: {reason}")
    return EXIT_OK


# --------------------------------------------------------------- candidates


def run_candidates(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    profile = _load_profile(workspace)

    with db.session() as conn:
        scores = discover.relevance(conn, profile, now_year=_now_year(), limit=args.pool)
        candidates = discover.build_candidates(
            conn, scores, top_papers=args.top_papers, min_evidence=args.min_evidence
        )
        rows = [
            {
                "person_id": c.person.person_id,
                "name": c.person.display_name,
                "orcid": c.person.orcid,
                "confidence": c.person.confidence,
                "resolution_method": c.person.resolution_method,
                "evidence": [e.as_dict() for e in c.evidence],
            }
            for c in candidates
        ]

    workspace.write_jsonl(workspace.candidate_dir / "candidates.jsonl", rows)
    state.mark("candidates")
    workspace.save_state(state)

    payload = {"candidates": len(rows), "papers_considered": len(scores)}
    if args.json:
        log.emit(payload)
    else:
        log.info(f"{len(rows)} candidates from {len(scores)} scored papers")
        low = [r for r in rows if r["confidence"] < 0.6]
        if low:
            log.warn(f"{len(low)} candidates resolved by name only — confirm before inviting")
    return EXIT_OK


# ------------------------------------------------------------------ enrich


def _homepage_overrides(values: list[str] | None) -> dict[str, list[str]]:
    """Parse ``--homepage <person_id>=<url>`` pairs.

    The escape hatch for the common case where a candidate has no ORCID URL but
    the editor can see their staff page. Supplying it is always better than
    letting the tool guess.
    """
    overrides: dict[str, list[str]] = {}
    for value in values or []:
        person_id, separator, url = value.partition("=")
        if not separator or not url.strip():
            raise UsageError(f"--homepage expects <person_id>=<url>, got {value!r}")
        overrides.setdefault(person_id.strip(), []).append(url.strip())
    return overrides


def run_enrich(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    rows = workspace.read_jsonl(workspace.candidate_dir / "candidates.jsonl")
    # Default is everyone. Affiliations feed the conflict rules and the
    # geography check, and the final ranking is not known until after those,
    # so capping here would silently leave top candidates without an
    # institution. --limit exists for when the user knowingly wants a
    # cheaper partial pass.
    subset = rows[: args.limit] if args.limit else rows

    # One fetcher for the whole pass, so its rate limit and per-host circuit
    # breaker apply across candidates rather than resetting for each one.
    fetcher = None if args.no_email else enrich_module.PageFetcher()
    homepages = _homepage_overrides(args.homepage)
    supplied_ranks: dict[str, tuple[str, str]] = {}
    if getattr(args, "homepages", None):
        from academia.reviewer.contact import read_lookups

        lookups = read_lookups(args.homepages)
        for person_id, urls in lookups.urls.items():
            homepages.setdefault(person_id, []).extend(urls)
        supplied_ranks = lookups.ranks
    # Co-authors in one field share papers; each landing page is fetched once.
    seen_pages: dict[str, list[str]] = {}

    enriched: list[dict] = []
    with db.session() as conn:
        for row in subset:
            person = repo.load_person(conn, row["person_id"])
            if person is None:
                continue
            person = enrich_module.enrich(conn, person)
            if (supplied := supplied_ranks.get(person.person_id)) is not None:
                rank, rank_source = supplied
                repo.set_stated_rank(conn, person.person_id, rank, source_url=rank_source)
                person.stated_rank, person.rank_source = rank, rank_source
            contact = (
                enrich_module.Contact()
                if args.no_email
                else enrich_module.contact_for(person)
            )
            finding = enrich_module.discover_email(
                conn,
                person,
                contact=contact,
                fetcher=fetcher,
                extra_urls=homepages.get(person.person_id, []),
                seen_pages=seen_pages,
            )
            enriched.append(
                {
                    "person_id": person.person_id,
                    "name": person.display_name,
                    "country": person.country_code,
                    "institution": (
                        person.current_affiliation.institution if person.current_affiliation else ""
                    ),
                    "education_entries": len(person.education),
                    "position": person.rank,
                    "email": finding.as_dict(),
                }
            )

    workspace.write_jsonl(workspace.audit_dir / "enrichment.jsonl", enriched)
    state.mark("enrich")
    workspace.save_state(state)

    with_email = sum(1 for e in enriched if e["email"]["email"])
    with_education = sum(1 for e in enriched if e["education_entries"])
    with_position = sum(1 for e in enriched if e["position"] != "unknown")
    payload = {
        "enriched": len(enriched),
        "with_email": with_email,
        "with_education": with_education,
        "with_position": with_position,
    }
    if args.json:
        log.emit(payload)
    else:
        log.info(f"enriched {len(enriched)} candidates")
        log.info(f"  public email found : {with_email}")
        log.info(f"  education recorded : {with_education} (ORCID fills this for a minority)")
    return EXIT_OK


# --------------------------------------------------------------------- coi


def _context(conn, profile: Profile) -> coi_module.ManuscriptContext:
    author_rows = repo.manuscript_authors(conn, profile.manuscript_id)
    return coi_module.ManuscriptContext(
        ms_id=profile.manuscript_id,
        author_names=[r["name"] for r in author_rows] or profile.author_names,
        author_person_ids=[r["person_id"] for r in author_rows if r["person_id"]],
        author_institutions=[r["affiliation"] for r in author_rows if r["affiliation"]]
        or profile.author_institutions,
        author_countries=profile.origin_countries,
        referenced_paper_ids=[],
        year=profile.year or _now_year(),
    )


def run_coi(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    profile = _load_profile(workspace)
    policy = load_policy(
        state.journal or profile.journal,
        exclusion_list=[n.strip() for n in (args.exclude or "").split(",") if n.strip()],
    )
    rows = workspace.read_jsonl(workspace.candidate_dir / "candidates.jsonl")

    run_id = state.run_id or stable_id("run", profile.manuscript_id, policy.fingerprint())
    verdicts: list[dict] = []

    with db.session() as conn:
        repo.create_run(
            conn, run_id=run_id, ms_id=profile.manuscript_id, config_hash=policy.fingerprint()
        )
        context = _context(conn, profile)
        manuscript_people = [
            p
            for p in (repo.load_person(conn, pid) for pid in context.author_person_ids)
            if p is not None
        ]
        for row in rows:
            person = repo.load_person(conn, row["person_id"])
            if person is None:
                continue
            verdict = coi_module.evaluate(
                conn, person, context, policy, manuscript_people=manuscript_people
            )
            coi_module.persist(conn, run_id, verdict)
            verdicts.append(
                {
                    "person_id": person.person_id,
                    "name": person.display_name,
                    "status": verdict.status,
                    "findings": [
                        {"rule": f.rule, "status": f.status, "evidence": f.evidence}
                        for f in verdict.findings
                    ],
                }
            )

    workspace.write_jsonl(workspace.audit_dir / "coi.jsonl", verdicts)
    state.run_id = run_id
    state.mark("coi")
    workspace.save_state(state)

    counts = {status: sum(1 for v in verdicts if v["status"] == status) for status in ("CLEAR", "REVIEW", "BLOCK")}
    payload = {"run_id": run_id, "policy": policy.sources, "counts": counts}
    if args.json:
        log.emit(payload)
    else:
        log.info(f"policy: {', '.join(Path(p).name for p in policy.sources)}")
        log.info(f"  clear  : {counts['CLEAR']} (no detected conflict)")
        log.info(f"  review : {counts['REVIEW']}")
        log.info(f"  blocked: {counts['BLOCK']}")
    return EXIT_OK


# ------------------------------------------------------------------ report


def run_report(args: argparse.Namespace) -> int:
    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    profile = _load_profile(workspace)
    policy = load_policy(state.journal or profile.journal)

    candidate_rows = workspace.read_jsonl(workspace.candidate_dir / "candidates.jsonl")
    coi_rows = {
        row["person_id"]: row
        for row in workspace.read_jsonl(workspace.audit_dir / "coi.jsonl")
    }
    try:
        email_rows = {
            row["person_id"]: row for row in workspace.read_jsonl(workspace.audit_dir / "enrichment.jsonl")
        }
    except UsageError:
        email_rows = {}

    with db.session() as conn:
        candidates: list[rank.Candidate] = []
        for row in candidate_rows:
            person = repo.load_person(conn, row["person_id"])
            if person is None:
                continue
            candidate = rank.Candidate(person=person)
            candidate.evidence = [
                rank.Evidence(
                    paper_id=e["paper_id"],
                    title=e["title"],
                    year=e["year"],
                    position=e["position"],
                    position_weight=e["position_weight"],
                    similarity=e["similarity"],
                )
                for e in row["evidence"]
            ]
            candidate.person.topics = discover.topics_for(conn, candidate)

            verdict_row = coi_rows.get(person.person_id)
            if verdict_row:
                verdict = coi_module.Verdict(person_id=person.person_id)
                for finding in verdict_row["findings"]:
                    verdict.add(
                        coi_module.Finding(finding["rule"], finding["status"], finding["evidence"])
                    )
                candidate.verdict = verdict

            candidate.geo = geo.assess(person, profile.origin_countries, policy)
            candidates.append(
                rank.score_candidate(
                    conn,
                    candidate,
                    profile_topics=profile.primary_topics,
                    profile_methods=profile.methods,
                    policy=policy,
                    now_year=_now_year(),
                )
            )

        ordered = rank.take(rank.rank(candidates), args.top)
        emails = {
            pid: enrich_module.EmailFinding(
                email=(row["email"] or {}).get("email") or "",
                source=(row["email"] or {}).get("source") or enrich_module.NOT_FOUND,
                source_url=(row["email"] or {}).get("source_url") or "",
                confidence=(row["email"] or {}).get("confidence") or 0.0,
            )
            for pid, row in email_rows.items()
        }
        rows = report.build_rows(ordered, emails)

        # candidate_scores is the ranking table, and a blocked candidate has no
        # ranking — score_candidate leaves its components empty by design. The
        # block itself is audited in coi_evidence, so nothing is lost here.
        for candidate in ordered:
            if not candidate.blocked:
                repo.record_score(
                    conn, state.run_id, candidate.person.person_id, candidate.score, candidate.components
                )

        unknown = [
            row.candidate.person.display_name
            for row in rows
            if row.institution == "unknown" and not row.candidate.blocked
        ]
        written = report.write_all(conn, workspace.shortlist_dir, rows, profile, policy.sources)

    state.mark("report")
    workspace.save_state(state)

    payload = {
        "shortlist": str(written["shortlist"]),
        "csv": str(written["csv"]),
        "dossiers": str(written["dossiers"]),
        "candidates": len(rows),
        "without_affiliation": unknown,
    }
    if args.json:
        log.emit(payload)
    else:
        log.info(f"shortlist: {written['shortlist']}")
        log.info(f"dossiers : {written['dossiers']}")
        if unknown:
            log.warn(
                f"{len(unknown)} shortlisted candidate(s) have no institution recorded: "
                + ", ".join(unknown[:5])
            )
            log.warn("run `rev-disc enrich` without --limit, then re-run coi and report")
    return EXIT_OK


# ------------------------------------------------------------------ status


def run_status(args: argparse.Namespace) -> int:
    from academia.reviewer.workspace import list_workspaces

    if not args.slug:
        slugs = list_workspaces()
        if args.json:
            log.emit({"workspaces": slugs})
        else:
            for slug in slugs:
                log.info(f"  {slug}")
            if not slugs:
                log.info("no workspaces yet")
        return EXIT_OK

    workspace = open_workspace(args.slug)
    state = workspace.load_state()
    if args.json:
        log.emit({**state.to_dict(), "next_stage": state.next_stage()})
    else:
        for stage, status in state.stages.items():
            log.info(f"  {stage:<12} {status}")
        log.info(f"next: rev-disc {state.next_stage()} --slug {state.slug}")
    return EXIT_OK


# ----------------------------------------------------------------- contacts


def run_contacts(args: argparse.Namespace) -> int:
    """List candidates still without an address, ready to be looked up.

    The pipeline reaches roughly a fifth of them from structured sources; the
    rest need a search, which is the orchestrating agent's job rather than the
    CLI's. Feed the answers back with `enrich --homepages`.
    """
    from academia.reviewer.contact import lookup_worklist

    workspace = open_workspace(args.slug)
    rows = workspace.read_jsonl(workspace.candidate_dir / "candidates.jsonl")

    with db.session() as conn:
        people = []
        resolved: set[str] = set()
        for row in rows:
            person = repo.load_person(conn, row["person_id"])
            if person is None:
                continue
            people.append(person)
            if repo.emails_of(conn, person.person_id):
                resolved.add(person.person_id)
        items = lookup_worklist(people, resolved=resolved)

    payload = {"missing": len(items), "resolved": len(resolved), "candidates": items}
    if args.json:
        log.emit(payload)
    else:
        log.info(f"{len(resolved)} of {len(people)} candidates have an address")
        for item in items:
            log.info(f"  {item['person_id']}  {item['name']} — {item['institution'] or 'unknown'}")
        log.info("Look these up, then: rev-disc enrich --slug "
                 f"{args.slug} --homepages <file.json>")
    return EXIT_OK
