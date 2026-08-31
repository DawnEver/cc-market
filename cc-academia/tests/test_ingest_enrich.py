"""Front-matter parsing and enrichment, including the rules about what is refused."""

from __future__ import annotations

import pytest

from academia.core.errors import SourceError
from academia.core.models import Author, Person
from academia.ingest import pdf as ingest_pdf
from academia.reviewer import enrich
from academia.store import db
from academia.store import repository as repo

FIRST_PAGE = """
IEEE TRANSACTIONS ON INDUSTRIAL ELECTRONICS, VOL. 73, NO. 4, APRIL 2026

Torque Ripple Suppression in Permanent Magnet Synchronous Motor Drives

Grace Expert, Senior Member, IEEE, and Ravi Junior, Member, IEEE

Abstract—This paper proposes a torque ripple suppression scheme for
permanent magnet synchronous motor drives used in traction applications.
Experimental results confirm the reduction.

Index Terms—Torque ripple, permanent magnet machines, traction drives.

I. INTRODUCTION
Torque ripple degrades ride comfort in electric vehicles, and the body of the
paper continues from here for many pages.
"""


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "e.db")
    yield connection
    connection.close()


# ------------------------------------------------------------ front matter


def test_front_matter_extracts_title_abstract_and_keywords():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "Torque Ripple Suppression" in parsed["title"]
    assert parsed["abstract"].startswith("This paper proposes")
    assert "Torque ripple" in parsed["keywords"]


def test_front_matter_stops_the_abstract_before_the_introduction():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "INTRODUCTION" not in parsed["abstract"]
    assert "ride comfort" not in parsed["abstract"]


def test_front_matter_ignores_the_all_caps_running_head():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "IEEE TRANSACTIONS" not in parsed["title"]


COVER_SHEET = """
Regular Paper
A Rotating Load Reconstruction Method to Predict Dominant
Electromagnetic Noise Orders in Double-Rotor Single-Stator
AFPM Machine
Submission ID
e94bacb1
Authors
Mr. Liming Liu
"""

WRAPPED_FRONT_PAGE = """
1
> REPLACE THIS LINE WITH YOUR MANUSCRIPT ID NUMBER (DOUBLE-CLICK HERE TO EDIT) <

A Rotating Load Reconstruction Method to Predict
Dominant Electromagnetic Noise Orders in Double-
Rotor Single-Stator AFPM Machine

Liming Liu, Lingyun Shao, Zhuoran Zhang, Zhongze Wu, and Wei Hua

Abstract�In double-rotor single-stator axial-flux permanent-magnet machines,
electromagnetic forces acting on rotor surfaces are the main excitation sources.

Index Terms�Axial flux machine, electromagnetic noise.

I. INTRODUCTION
"""


def test_front_matter_joins_a_title_wrapped_across_lines():
    parsed = ingest_pdf.parse_front_matter(WRAPPED_FRONT_PAGE)
    assert parsed["title"] == (
        "A Rotating Load Reconstruction Method to Predict Dominant "
        "Electromagnetic Noise Orders in Double-Rotor Single-Stator AFPM Machine"
    )


def test_front_matter_strips_the_replacement_character_after_abstract():
    parsed = ingest_pdf.parse_front_matter(WRAPPED_FRONT_PAGE)
    assert parsed["abstract"].startswith("In double-rotor")
    assert parsed["keywords"][0] == "Axial flux machine"


def test_front_matter_page_skips_a_submission_cover_sheet():
    assert ingest_pdf.select_front_matter_page([COVER_SHEET, "", WRAPPED_FRONT_PAGE]) == 2


def test_front_matter_page_falls_back_to_the_first_page():
    assert ingest_pdf.select_front_matter_page([COVER_SHEET, "nothing here"]) == 0


def test_front_matter_recovers_a_doi_when_present():
    parsed = ingest_pdf.parse_front_matter("Digital Object Identifier 10.1109/TIE.2026.1234567")
    assert parsed["doi"] == "10.1109/tie.2026.1234567"


def test_front_matter_returns_empty_rather_than_guessing():
    parsed = ingest_pdf.parse_front_matter("")
    assert parsed["title"] == ""
    assert parsed["abstract"] == ""


def test_decomposition_refuses_without_the_optional_extra(tmp_path, monkeypatch):
    """A half-decomposed directory reads as success to every later step."""
    from academia.core.errors import UsageError

    monkeypatch.setattr(ingest_pdf, "_has_ingest", lambda: False)
    with pytest.raises(UsageError):
        ingest_pdf.decompose(tmp_path / "x.pdf", tmp_path / "out")


# ------------------------------------------------------------------ email


def test_role_addresses_are_not_treated_as_personal():
    found = enrich.extract_emails("Contact info@uni.edu or grace.expert@uni.edu")
    assert "info@uni.edu" not in found
    assert "grace.expert@uni.edu" in found


def test_an_address_must_match_the_person_to_be_used():
    person = Person(person_id="p", display_name="Grace Expert")
    emails = ["someone.else@uni.edu", "g.expert@uni.edu"]
    assert enrich.match_email_to_person(emails, person) == "g.expert@uni.edu"


def test_an_unrelated_departmental_address_is_rejected():
    """Otherwise the invitation reaches whoever appeared first on the page."""
    person = Person(person_id="p", display_name="Grace Expert")
    assert enrich.match_email_to_person(["postgrad.office@uni.edu"], person) == ""


def test_no_address_is_ever_generated_from_a_pattern(conn):
    person = Person(person_id="p", display_name="Grace Expert")
    finding = enrich.find_email(conn, person)
    assert not finding.found
    assert finding.source == enrich.NOT_FOUND
    assert finding.email == ""


def test_a_found_address_records_where_it_came_from(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    person = repo.load_person(conn, person_id)

    pages = {"https://www.uni.ac.uk/people/grace": "Email: grace.expert@uni.ac.uk"}
    finding = enrich.find_email(
        conn, person, page_fetcher=pages.get, homepage_urls=list(pages)
    )
    assert finding.email == "grace.expert@uni.ac.uk"
    assert finding.source == "institutional_profile"
    assert finding.source_url.startswith("https://www.uni.ac.uk")
    assert finding.confidence >= 0.9

    stored = repo.emails_of(conn, person_id)
    assert stored[0]["source_url"] == finding.source_url


def test_a_blocked_page_is_skipped_rather_than_retried(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    person = repo.load_person(conn, person_id)

    attempts = []

    def fetcher(url):
        attempts.append(url)
        raise RuntimeError("403")

    finding = enrich.find_email(
        conn, person, page_fetcher=fetcher, homepage_urls=["https://blocked.example/"]
    )
    assert not finding.found
    assert attempts == ["https://blocked.example/"]


def test_a_stored_address_is_reused_without_fetching(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    repo.record_email(
        conn, person_id, "grace@uni.edu", source="published_corresponding",
        source_url="https://doi.org/10.1/x", confidence=0.95,
    )
    person = repo.load_person(conn, person_id)

    def explode(url):
        raise AssertionError("must not fetch when an address is already known")

    finding = enrich.find_email(conn, person, page_fetcher=explode, homepage_urls=["https://x/"])
    assert finding.email == "grace@uni.edu"
    assert finding.source == "published_corresponding"


RUN_ON_FRONT_PAGE = """
A Rotating Load Reconstruction Method to Predict
Dominant Electromagnetic Noise Orders
Liming Liu, Lingyun Shao, and Wei Hua
School of Electrical Engineering, Southeast University, Nanjing 210096, China
This paper proposes a rotating electromagnetic load reconstruction method that
directly predicts the dominant noise orders without spatial-order decomposition,
and validates it against acoustic measurements on a prototype machine.
"""


def test_title_does_not_absorb_authors_affiliations_or_prose():
    """The joined title is written to sanitized.json and read by every later stage.

    Extractors routinely emit a front page with no blank lines and no IEEE
    membership byline. Appending every contiguous line then walks the title
    straight through the author list into the abstract — carrying manuscript
    body text past the one command allowed to see it.
    """
    parsed = ingest_pdf.parse_front_matter(RUN_ON_FRONT_PAGE)
    title = parsed["title"]

    assert title.startswith("A Rotating Load Reconstruction Method")
    assert "Liming Liu" not in title
    assert "Southeast University" not in title
    assert "This paper proposes" not in title


def test_title_is_bounded_even_when_nothing_looks_like_a_boundary():
    lines = "\n".join(f"Continuation line number {i} of an endless block" for i in range(40))
    parsed = ingest_pdf.parse_front_matter(lines)
    assert len(parsed["title"].split()) <= ingest_pdf.TITLE_WORD_LIMIT


def test_a_title_with_a_comma_is_not_mistaken_for_an_author_list():
    parsed = ingest_pdf.parse_front_matter(
        "Design, analysis and control of axial flux machines\n\nAbstract—Body follows."
    )
    assert parsed["title"] == "Design, analysis and control of axial flux machines"


# ------------------------------------------------------- email discovery


ORCID_EMAIL_PAYLOAD = {
    "email": [
        {"email": "private@example.org", "visibility": "LIMITED"},
        {"email": "ada.researcher@uni.edu", "visibility": "PUBLIC"},
    ]
}

ORCID_URLS_PAYLOAD = {
    "researcher-url": [
        {"url-name": "Lab", "url": {"value": "https://lab.example.org/ada"}},
        {"url-name": "Profile", "url": {"value": "https://www.uni.edu/staff/ada"}},
    ]
}


class StubOrcidContact:
    """An Orcid client that answers the two contact sections and nothing else."""

    def __init__(self, email=None, urls=None):
        self.payloads = {"email": email or {}, "researcher-urls": urls or {}}
        self.calls = []

    def _fetch(self, orcid, section, timeout):
        self.calls.append(section)
        return self.payloads.get(section, {})


def test_orcid_contact_reads_only_public_addresses():
    """ORCID defaults addresses to private; a limited one is not ours to use."""
    from academia.sources.orcid import Orcid

    client = Orcid()
    client._fetch = StubOrcidContact(ORCID_EMAIL_PAYLOAD, ORCID_URLS_PAYLOAD)._fetch
    contact = client.get_contact("0000-0002-1825-0097")

    assert contact.emails == ["ada.researcher@uni.edu"]
    assert contact.urls == ["https://lab.example.org/ada", "https://www.uni.edu/staff/ada"]


def test_orcid_contact_tolerates_an_empty_record():
    from academia.sources.orcid import Orcid

    client = Orcid()
    client._fetch = StubOrcidContact()._fetch
    contact = client.get_contact("0000-0002-1825-0097")

    assert contact.emails == []
    assert contact.urls == []


def test_page_fetcher_stops_hitting_a_host_that_keeps_failing():
    """The design circuit-breaks rather than retrying; a dead host must cost little."""
    from academia.reviewer.enrich import PageFetcher

    attempts = []

    def failing(url, source, timeout=0):
        attempts.append(url)
        raise SourceError("http_503", "page")

    fetcher = PageFetcher(getter=failing, delay=0.0, failure_budget=2)
    for index in range(6):
        fetcher(f"https://dead.example.org/{index}")

    assert len(attempts) == 2
    # A different host is unaffected by the first one's failures.
    fetcher("https://alive.example.org/a")
    assert len(attempts) == 3


def test_page_fetcher_truncates_an_oversized_page():
    from academia.reviewer.enrich import PageFetcher

    fetcher = PageFetcher(getter=lambda *a, **k: "x" * 10_000, delay=0.0, max_bytes=100)
    assert len(fetcher("https://example.org/big")) == 100


def test_page_fetcher_uses_browser_fallback_after_http_failure():
    from academia.reviewer.enrich import PageFetcher

    def failing(*args, **kwargs):
        raise SourceError("http_403", "page")

    fetcher = PageFetcher(
        getter=failing,
        fallback_getter=lambda url: (b"contact: ada@example.edu", "text/html", url),
        delay=0.0,
    )

    assert fetcher("https://publisher.example/paper") == "contact: ada@example.edu"


def test_email_discovery_prefers_an_institutional_page_over_public_orcid(conn):
    """The documented precedence is institutional > lab > ORCID, not cheapest first."""
    from academia.reviewer import enrich as enrich_module

    person = Person(person_id="p1", display_name="Ada Researcher", orcid="0000-0002-1825-0097")
    repo.upsert_person(conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097"))
    person.person_id = repo.upsert_person(
        conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097")
    )

    pages = {
        "https://www.uni.edu/staff/ada": "Contact a.researcher@uni.edu for enquiries",
    }
    finding = enrich_module.discover_email(
        conn,
        person,
        contact=enrich_module.Contact(emails=["ada@gmail.com"], urls=list(pages)),
        fetcher=lambda url: pages.get(url, ""),
    )

    assert finding.email == "a.researcher@uni.edu"
    assert finding.source == "institutional_profile"
    assert finding.source_url == "https://www.uni.edu/staff/ada"


def test_email_discovery_falls_back_to_a_public_orcid_address(conn):
    from academia.reviewer import enrich as enrich_module

    person_id = repo.upsert_person(
        conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097")
    )
    person = Person(person_id=person_id, display_name="Ada Researcher")

    finding = enrich_module.discover_email(
        conn,
        person,
        contact=enrich_module.Contact(emails=["ada.researcher@uni.edu"], urls=[]),
        fetcher=None,
    )

    assert finding.email == "ada.researcher@uni.edu"
    assert finding.source == "orcid_public"
    assert finding.confidence == enrich_module.EMAIL_CONFIDENCE["orcid_public"]


def test_email_discovery_never_generates_an_address(conn):
    """A page with no matching address yields not_found, never a constructed one."""
    from academia.reviewer import enrich as enrich_module

    person_id = repo.upsert_person(conn, Author(name="Ada Researcher", idx=0, openalex_id="A1"))
    person = Person(person_id=person_id, display_name="Ada Researcher")

    finding = enrich_module.discover_email(
        conn,
        person,
        contact=enrich_module.Contact(emails=[], urls=["https://www.uni.edu/staff/other"]),
        fetcher=lambda url: "Contact bob.other@uni.edu",
    )

    assert finding.email == ""
    assert finding.source == enrich_module.NOT_FOUND


def test_cover_pages_are_counted_so_decomposition_can_skip_them():
    """An editorial cover sheet has headings, so a splitter treats it as the paper.

    A live TTE submission decomposed into "Authors", "Additional Information"
    and "Files for Peer Review" — the Atypon cover — with the actual manuscript
    nowhere in the section list.
    """
    cover = "Regular Paper\nSubmission ID\nAuthors\nMr. Liming Liu\n"
    paper = "A Rotating Load Reconstruction Method\n\nAbstract\u2014In double-rotor machines...\n"

    assert ingest_pdf.cover_page_count([cover, paper]) == 1
    assert ingest_pdf.cover_page_count([paper, "body text"]) == 0
    assert ingest_pdf.cover_page_count(["no abstract anywhere", "still none"]) == 0


def test_page_fetcher_blames_the_publisher_not_the_doi_redirector():
    """doi.org fronts almost every landing page; it must never trip the breaker."""
    from academia.reviewer.enrich import PageFetcher

    attempts = []

    def failing(url, source, timeout=0):
        attempts.append(url)
        raise SourceError("http_403", "page")

    fetcher = PageFetcher(getter=failing, delay=0.0, failure_budget=2)
    for index in range(5):
        fetcher(f"https://doi.org/10.3390/en{index}")

    # Failures cannot be attributed to a publisher that was never reached, so
    # they are not counted against the redirector either.
    assert len(attempts) == 5


# ------------------------------------------------------- submitting authors


COVER_AUTHORS = """
Regular Paper
A Rotating Load Reconstruction Method to Predict Dominant
Electromagnetic Noise Orders in Double-Rotor Single-Stator
AFPM Machine
Submission ID
e94bacb1-3cd2-49d0-bd47-f260156eae60
Submission Version
Initial Submission
PDF Generation
19 Aug 2026 02:22:09 EST by Atypon ReX
Authors
Mr. Liming Liu
Affiliations
\ufffd the School of Electrical Engineering, Southeast
University, Nanjing 210096, China
Dr. Lingyun Shao
Corresponding Author
Submitting Author
ORCiD
https://orcid.org/0000-0002-6072-0849
Affiliations
\ufffd the College of Automation Engineering, Nanjing
University of Aeronautics and Astronautics, Nanjing
211106, China
Prof. Wei Hua
Affiliations
\ufffd the School of Electrical Engineering, Southeast
University, Nanjing 210096, China
For consideration in IEEE Transactions on Transportation Electrification
Page 1 of 12
"""


def test_cover_sheet_authors_are_extracted_with_affiliations():
    """COI cannot work without the author list, and asking for it by hand is
    exactly where it gets forgotten — leaving every conflict rule vacuous."""
    authors = ingest_pdf.parse_cover_authors(COVER_AUTHORS)

    assert [a.name for a in authors] == ["Liming Liu", "Lingyun Shao", "Wei Hua"]
    assert "Southeast University" in authors[0].affiliation
    assert "Nanjing University of Aeronautics" in authors[1].affiliation
    assert authors[0].country == "CN"


def test_the_corresponding_authors_orcid_is_captured():
    authors = ingest_pdf.parse_cover_authors(COVER_AUTHORS)
    assert authors[1].orcid == "0000-0002-6072-0849"
    assert authors[0].orcid == ""


def test_honorifics_are_stripped_from_author_names():
    authors = ingest_pdf.parse_cover_authors(COVER_AUTHORS)
    assert not any(a.name.startswith(("Mr.", "Dr.", "Prof.")) for a in authors)


def test_a_page_with_no_author_block_yields_nothing():
    assert ingest_pdf.parse_cover_authors("Just a title\n\nAbstract—text") == []


BYLINE_PAGE = """
A Rotating Load Reconstruction Method to Predict
Dominant Electromagnetic Noise Orders

Liming Liu, Lingyun Shao, Zhuoran Zhang, Zhongze Wu, and Wei Hua

Abstract\ufffdIn double-rotor machines...
"""


def test_the_byline_is_read_when_there_is_no_cover_sheet():
    """Not every submission arrives through an editorial system."""
    authors = ingest_pdf.parse_byline_authors(BYLINE_PAGE)

    assert [a.name for a in authors] == [
        "Liming Liu",
        "Lingyun Shao",
        "Zhuoran Zhang",
        "Zhongze Wu",
        "Wei Hua",
    ]


def test_ieee_membership_grades_are_not_read_as_names():
    authors = ingest_pdf.parse_byline_authors(
        "Title Of The Paper Here\n\n"
        "Grace Expert, Senior Member, IEEE, and Ravi Junior, Member, IEEE\n\n"
        "Abstract\u2014text"
    )
    assert [a.name for a in authors] == ["Grace Expert", "Ravi Junior"]
