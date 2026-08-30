"""Argument parsing and dispatch.

Deliberately thin: every command body lives in its domain module. The old 713-line
``cli.py`` mixed parser construction with business logic, which is why a
one-parameter change used to touch three unrelated code paths.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable

from academia import __version__
from academia.core import log
from academia.core.errors import EXIT_USAGE, AcademiaError

Handler = Callable[[argparse.Namespace], int]


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON on stdout.")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose progress on stderr.")


def _add_facts_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--no-facts-sync",
        action="store_true",
        help="Do not read or write the shared facts folder for this command.",
    )


def build_academia_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="academia",
        description="cc-academia maintenance commands.",
    )
    parser.add_argument("--version", action="version", version=f"cc-academia {__version__}")
    sub = parser.add_subparsers(dest="command")

    doctor = sub.add_parser("doctor", help="Check the environment: paths, config, database, sources.")
    _add_common(doctor)

    db = sub.add_parser("db", help="Manage the accumulating scholarly database.")
    db_sub = db.add_subparsers(dest="db_command")
    for name, help_text in (
        ("init", "Create the database and apply the schema."),
        ("stats", "Row counts per table."),
        ("vacuum", "Compact the database file."),
    ):
        child = db_sub.add_parser(name, help=help_text)
        _add_common(child)

    return parser


def _dispatch(parser: argparse.ArgumentParser, handlers: dict[str, Handler], argv: list[str]) -> int:
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_USAGE

    log.set_verbose(getattr(args, "verbose", False))
    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        return EXIT_USAGE

    try:
        return handler(args)
    except AcademiaError as error:
        log.error(str(error))
        return error.exit_code
    except KeyboardInterrupt:
        log.error("interrupted")
        return 130


def _academia_handlers() -> dict[str, Handler]:
    from academia.cli import doctor as doctor_cmd

    return {
        "doctor": doctor_cmd.run,
        "db": doctor_cmd.run_db,
    }


def build_rev_disc_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rev-disc",
        description="Reviewer discovery: manuscript in, evidenced shortlist out.",
        epilog=(
            "Pipeline: init -> profile -> search -> candidates -> enrich -> coi -> report\n"
            "Every stage is resumable; `rev-disc status --slug <s>` says what is next."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"cc-academia {__version__}")
    sub = parser.add_subparsers(dest="command")

    init = sub.add_parser("init", help="Create a workspace and write the sanitized record.")
    init.add_argument("pdf", nargs="?", help="Manuscript PDF. Read only by this command.")
    init.add_argument("--slug", help="Workspace name; derived from the file or title otherwise.")
    init.add_argument("--title", help="Use instead of a PDF when metadata is supplied by hand.")
    init.add_argument("--abstract", default="")
    init.add_argument("--keywords", default="", help="Comma-separated author keywords.")
    init.add_argument(
        "--authors",
        default="",
        help='Submitting authors, used for conflict screening only: '
        '"Name|Institution|CC; Other Name". Read from the PDF when it has them.',
    )
    init.add_argument("--journal", default="", help="Journal slug, e.g. tie, tii, tte.")
    init.add_argument("--year", type=int)
    _add_common(init)

    profile = sub.add_parser("profile", help="Derive topics, methods and search queries.")
    profile.add_argument(
        "--approve",
        action="store_true",
        help="Record that you have read the queries. Required before search; "
        "editing them afterwards re-arms the gate.",
    )
    profile.add_argument("--slug", required=True)
    _add_common(profile)

    search = sub.add_parser("search", help="Run the queries across sources and store the papers.")
    search.add_argument("--slug", required=True)
    search.add_argument("--source", action="append", help="Repeatable: openalex, ieee.")
    search.add_argument("--pages", type=int, default=2)
    search.add_argument("--per-page", type=int, default=25)
    search.add_argument("--year-from", type=int)
    _add_common(search)

    candidates = sub.add_parser("candidates", help="Score papers, then take their authors.")
    candidates.add_argument("--slug", required=True)
    candidates.add_argument("--pool", type=int, default=300, help="Papers to score.")
    candidates.add_argument("--top-papers", type=int, default=50, help="Papers to harvest authors from.")
    candidates.add_argument("--min-evidence", type=int, default=1)
    _add_facts_flag(candidates)
    _add_common(candidates)

    enrich = sub.add_parser("enrich", help="Affiliation, career history and public email.")
    enrich.add_argument("--slug", required=True)
    enrich.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Cap the number enriched (0 = all, the default). Affiliations feed "
        "the conflict rules, so a cap can leave top candidates unscreened.",
    )
    enrich.add_argument(
        "--no-email",
        action="store_true",
        help="Skip contact discovery. Nothing is fetched from outside the APIs.",
    )
    enrich.add_argument(
        "--homepage",
        action="append",
        metavar="PERSON_ID=URL",
        help="A page to read for one candidate's address, when ORCID lists none. "
        "Repeatable.",
    )
    enrich.add_argument(
        "--homepages",
        metavar="FILE",
        help="JSON answers to a `rev-disc contacts` worklist: person_id to a "
        "URL, a list of URLs, or {urls, rank, rank_source}.",
    )
    _add_facts_flag(enrich)
    _add_common(enrich)

    coi = sub.add_parser("coi", help="Run the conflict rules. No model is involved.")
    coi.add_argument("--slug", required=True)
    coi.add_argument("--exclude", default="", help="Comma-separated names to block outright.")
    _add_facts_flag(coi)
    _add_common(coi)

    report = sub.add_parser("report", help="Rank and render the shortlist.")
    report.add_argument("--slug", required=True)
    report.add_argument(
        "--top",
        type=int,
        default=0,
        help="Cap the invitable list. Default 0 = everyone, because the "
        "editor picks from a broad slate rather than being handed a few.",
    )
    _add_facts_flag(report)
    _add_common(report)

    contacts = sub.add_parser(
        "contacts", help="List candidates still needing an address looked up."
    )
    contacts.add_argument("--slug", required=True)
    _add_facts_flag(contacts)
    _add_common(contacts)

    invite = sub.add_parser(
        "invite",
        help="Record that a candidate was invited, and how they answered.",
        description="Invitation history is what makes the next manuscript's "
        "ranking better than this one's, and it is the only evidence the "
        "responsiveness rules have to work with.",
    )
    invite.add_argument("--slug", required=True)
    invite.add_argument("--person", required=True, help="person_id from the shortlist.")
    invite.add_argument("--invited-at", default="", help="ISO date. Defaults to today.")
    invite.add_argument(
        "--responded",
        choices=("yes", "no"),
        default="",
        help="Leave unset while the outcome is still open — an unrecorded "
        "answer is not counted as a silence.",
    )
    invite.add_argument("--accepted", choices=("yes", "no"), default="")
    invite.add_argument("--note", default="", help="Review quality, free text.")
    _add_facts_flag(invite)
    _add_common(invite)

    facts = sub.add_parser(
        "facts",
        help="Merge and publish the portable facts other devices can share.",
        description="Invitations, verified ranks, addresses, affiliations and "
        "doctorate years are the only things in the store nobody can re-derive. "
        "They are kept as text, one directory per device, in a folder a sync "
        "client can carry between machines. The database itself is never synced: "
        "WAL mode makes a file-level syncer corrupt it silently.",
    )
    facts.add_argument("--dir", help="Override the shared facts folder for this run.")
    facts.add_argument(
        "--export-only", action="store_true", help="Publish this device's facts without merging."
    )
    facts.add_argument(
        "--import-only", action="store_true", help="Merge other devices' facts without publishing."
    )
    _add_common(facts)

    status = sub.add_parser("status", help="Show run state, or list workspaces.")
    status.add_argument("--slug")
    _add_common(status)

    return parser


def _rev_disc_handlers() -> dict[str, Handler]:
    from academia.cli import rev_disc

    return {
        "init": rev_disc.run_init,
        "profile": rev_disc.run_profile,
        "search": rev_disc.run_search,
        "candidates": rev_disc.run_candidates,
        "enrich": rev_disc.run_enrich,
        "coi": rev_disc.run_coi,
        "report": rev_disc.run_report,
        "contacts": rev_disc.run_contacts,
        "invite": rev_disc.run_invite,
        "facts": rev_disc.run_facts,
        "status": rev_disc.run_status,
    }


def main(argv: list[str] | None = None) -> int:
    return _dispatch(build_academia_parser(), _academia_handlers(), argv or sys.argv[1:])


def lit_review_main(argv: list[str] | None = None) -> int:
    from academia.cli import lit_review

    return _dispatch(
        lit_review.build_parser(), lit_review.handlers(), argv or sys.argv[1:]
    )


def ms_review_main(argv: list[str] | None = None) -> int:
    from academia.cli import ms_review

    return _dispatch(ms_review.build_parser(), ms_review.handlers(), argv or sys.argv[1:])


def rev_disc_main(argv: list[str] | None = None) -> int:
    return _dispatch(build_rev_disc_parser(), _rev_disc_handlers(), argv or sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
