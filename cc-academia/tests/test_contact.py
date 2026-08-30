"""Finding a reviewer's address in the literature they published.

The highest-confidence source is the corresponding-author footnote of their own
papers — it is where an editor would look by hand. Measured on a live sample:
publishers answer a direct PDF request with 403, but the open-access *landing
page* carries the address as HTML in 7 of 12 cases. So this reads landing pages,
not PDFs.
"""

from __future__ import annotations

import pytest

from academia.core.models import Author, Paper, Person
from academia.reviewer import contact
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "c.db")
    yield connection
    connection.close()


SPRINGER_PAGE = """
<html><body>
 <p>Correspondence to <a href="mailto:g.liu@ujs.edu.cn">Guohai Liu</a>.</p>
 <a href="mailto:journalpermissions@springernature.com">Permissions</a>
</body></html>
"""


def test_publisher_boilerplate_is_not_a_reviewer_address():
    """A landing page carries the journal's own addresses beside the author's."""
    found = contact.extract_page_emails(SPRINGER_PAGE)
    assert "g.liu@ujs.edu.cn" in found
    assert "journalpermissions@springernature.com" not in found


@pytest.mark.parametrize(
    "address",
    [
        "permissions@elsevier.com",
        "onlinelibrary@wiley.com",
        "support@mdpi.com",
        "reprints@ieee.org",
    ],
)
def test_known_publisher_domains_are_rejected(address):
    assert contact.is_publisher_address(address)


def test_a_university_address_is_not_rejected():
    assert not contact.is_publisher_address("g.liu@ujs.edu.cn")


def _paper_with_author(conn, paper_id, person_name, *, corresponding, landing):
    paper = Paper(
        paper_id=paper_id,
        source="openalex",
        title=f"Work {paper_id}",
        year=2024,
        landing_page_url=landing,
    )
    paper.authors = [
        Author(name=person_name, idx=0, orcid="0000-0002-1825-0097", is_corresponding=corresponding)
    ]
    repo.ingest_paper(conn, paper)
    return paper


def test_email_is_taken_from_the_candidates_own_paper(conn):
    _paper_with_author(
        conn, "p1", "Guohai Liu", corresponding=True, landing="https://doi.org/10.1/x"
    )
    person = repo.load_person(conn, repo.upsert_person(conn, Author(name="Guohai Liu", idx=0, orcid="0000-0002-1825-0097")))

    finding = contact.email_from_publications(
        conn, person, fetcher=lambda url: SPRINGER_PAGE
    )

    assert finding.email == "g.liu@ujs.edu.cn"
    assert finding.source == "published_corresponding"
    assert finding.source_url == "https://doi.org/10.1/x"


def test_a_co_authors_address_is_not_attributed_to_the_candidate(conn):
    """The footnote address belongs to whoever corresponded, not to every author."""
    _paper_with_author(
        conn, "p1", "Wenxiang Zhao", corresponding=False, landing="https://doi.org/10.1/x"
    )
    person = repo.load_person(conn, repo.upsert_person(conn, Author(name="Wenxiang Zhao", idx=0, orcid="0000-0002-1825-0097")))

    finding = contact.email_from_publications(
        conn, person, fetcher=lambda url: SPRINGER_PAGE
    )

    assert finding.email == ""


def test_a_sole_address_is_not_assigned_to_the_wrong_co_corresponding_author(conn):
    """A source may mark several authors corresponding but print one address."""
    paper = Paper(
        paper_id="p1",
        source="openalex",
        title="Joint work",
        year=2024,
        landing_page_url="https://example.edu/paper",
        authors=[
            Author(name="Rundong Huang", idx=0, orcid="0000-0001-0000-0001", is_corresponding=True),
            Author(name="Chunhua Liu", idx=1, orcid="0000-0001-0000-0002", is_corresponding=True),
        ],
    )
    repo.ingest_paper(conn, paper)
    person_id = repo.upsert_person(
        conn, Author(name="Chunhua Liu", idx=1, orcid="0000-0001-0000-0002")
    )
    repo.upsert_person(
        conn, Author(name="Chun Hua Liu", idx=1, orcid="0000-0001-0000-0002")
    )
    repo.upsert_person(
        conn, Author(name="Chun-Hua Liu", idx=1, orcid="0000-0001-0000-0002")
    )
    person = repo.load_person(conn, person_id)

    finding = contact.email_from_publications(
        conn,
        person,
        fetcher=lambda url: "Contact: rundhuang2@cityu.edu.hk",
    )

    assert finding.email == ""


def test_papers_where_the_candidate_corresponded_are_tried_first(conn):
    """Fetches cost a second each; the paper most likely to carry their address wins."""
    _paper_with_author(conn, "p1", "Ada Lead", corresponding=False, landing="https://a/1")
    _paper_with_author(conn, "p2", "Ada Lead", corresponding=True, landing="https://a/2")
    person = repo.load_person(conn, repo.upsert_person(conn, Author(name="Ada Lead", idx=0, orcid="0000-0002-1825-0097")))

    order = []
    contact.email_from_publications(
        conn, person, fetcher=lambda url: order.append(url) or ""
    )

    assert order[0] == "https://a/2"


def test_nothing_is_fetched_without_a_landing_page(conn):
    _paper_with_author(conn, "p1", "Ada Lead", corresponding=True, landing="")
    person = repo.load_person(conn, repo.upsert_person(conn, Author(name="Ada Lead", idx=0, orcid="0000-0002-1825-0097")))

    calls = []
    finding = contact.email_from_publications(
        conn, person, fetcher=lambda url: calls.append(url) or ""
    )

    assert calls == []
    assert finding.email == ""


# ------------------------------------------------------- the manual bridge


def test_lookup_worklist_names_who_is_missing_and_where_they_work(conn):
    """Automatic discovery tops out around a fifth of candidates in this field.

    Every structured source was measured: publisher landing pages 403 for IEEE,
    MDPI and IET; no repository copies exist; Crossref carries no addresses. So
    the remainder has to be looked up by a human or an agent with a search tool,
    and the tool's job is to hand over an actionable list rather than a column
    of "not found".
    """
    person_id = repo.upsert_person(conn, Author(name="Guohai Liu", idx=0, openalex_id="A9"))
    repo.store_institution_for(
        conn, person_id, name="Jiangsu University", country_code="CN", is_current=True
    )
    person = repo.load_person(conn, person_id)

    items = contact.lookup_worklist([person])

    assert len(items) == 1
    assert items[0]["name"] == "Guohai Liu"
    assert items[0]["institution"] == "Jiangsu University"
    assert "Guohai Liu" in items[0]["suggested_query"]
    assert "Jiangsu University" in items[0]["suggested_query"]


def test_a_candidate_with_nothing_missing_drops_off_the_worklist(conn):
    person_id = repo.upsert_person(conn, Author(name="Ada Found", idx=0, openalex_id="A1"))
    repo.store_institution_for(
        conn, person_id, name="Uni", role="Professor", is_current=True, source="orcid"
    )
    person = repo.load_person(conn, person_id)

    assert contact.lookup_worklist([person], resolved={person_id}) == []


def test_batch_homepages_are_read_from_a_file(tmp_path):
    """An agent resolving 30 candidates should not pass 30 command-line flags."""
    import json

    path = tmp_path / "homepages.json"
    path.write_text(
        json.dumps({"person-1": ["https://a.edu/x"], "person-2": "https://b.edu/y"}),
        encoding="utf-8",
    )

    assert contact.read_homepage_file(path) == {
        "person-1": ["https://a.edu/x"],
        "person-2": ["https://b.edu/y"],
    }


def test_lookup_answers_record_empty_searches_as_attempts(tmp_path):
    import json

    path = tmp_path / "lookups.json"
    path.write_text(
        json.dumps(
            {
                "person-1": {
                    "queries": ["Ada Lovelace faculty profile"],
                    "urls_seen": ["https://example.edu/search"],
                    "urls": [],
                    "outcome": "no_public_data",
                },
                "person-2": "https://example.edu/person-2",
            }
        ),
        encoding="utf-8",
    )

    lookups = contact.read_lookups(path)

    assert lookups.attempts[0].person_id == "person-1"
    assert lookups.attempts[0].outcome == "no_public_data"
    assert lookups.attempts[0].queries == ["Ada Lovelace faculty profile"]
    assert lookups.attempts[1].outcome == "found"
    assert lookups.attempts[1].urls_selected == ["https://example.edu/person-2"]


def test_lookup_coverage_distinguishes_unsearched_from_searched_empty():
    items = [{"person_id": f"person-{index}"} for index in range(5)]
    attempts = [
        contact.LookupAttempt(person_id="person-0", outcome="no_public_data"),
        contact.LookupAttempt(person_id="person-1", outcome="no_public_data"),
    ]

    annotated, summary = contact.annotate_lookup_status(items, attempts, total=5)

    assert summary == {"missing": 5, "resolved": 0, "never_searched": 3}
    assert [item["searched"] for item in annotated] == [True, True, False, False, False]
    assert annotated[0]["last_outcome"] == "no_public_data"
    assert annotated[2]["last_outcome"] == ""


def test_a_malformed_homepage_file_is_a_usage_error(tmp_path):
    from academia.core.errors import UsageError

    path = tmp_path / "bad.json"
    path.write_text('["not", "a", "mapping"]', encoding="utf-8")

    with pytest.raises(UsageError):
        contact.read_homepage_file(path)


# ------------------------------------------------ attributing to the right person


def test_initials_plus_surname_is_a_strong_match():
    from academia.reviewer.enrich import match_strength

    person = Person(person_id="p", display_name="Guohai Liu")
    assert match_strength("ghliu@ujs.edu.cn", person) == 2
    assert match_strength("guohai.liu@ujs.edu.cn", person) == 2


def test_a_bare_surname_is_only_a_weak_match():
    from academia.reviewer.enrich import match_strength

    person = Person(person_id="p", display_name="Guohai Liu")
    assert match_strength("wei.liu@ujs.edu.cn", person) == 1
    assert match_strength("zhang@ujs.edu.cn", person) == 0


def test_a_directory_page_does_not_attribute_a_namesakes_address():
    """A department listing carries dozens of addresses and several surnames.

    Matching on the surname alone is how an invitation reaches the wrong Liu.
    """
    from academia.reviewer.enrich import match_email_to_person

    person = Person(person_id="p", display_name="Guohai Liu")
    directory = ["wei.liu@ujs.edu.cn", "hui.liu@ujs.edu.cn", "zhang@ujs.edu.cn"]

    assert match_email_to_person(directory, person) == ""


def test_the_right_person_is_still_found_on_a_directory_page():
    from academia.reviewer.enrich import match_email_to_person

    person = Person(person_id="p", display_name="Guohai Liu")
    directory = ["wei.liu@ujs.edu.cn", "ghliu@ujs.edu.cn", "zhang@ujs.edu.cn"]

    assert match_email_to_person(directory, person) == "ghliu@ujs.edu.cn"


def test_a_sole_weak_match_on_a_personal_page_is_accepted():
    """On someone's own profile page there is no one else it could belong to."""
    from academia.reviewer.enrich import match_email_to_person

    person = Person(person_id="p", display_name="Guohai Liu")
    assert match_email_to_person(["liu@ujs.edu.cn"], person) == "liu@ujs.edu.cn"


def test_a_page_on_the_institutions_own_domain_is_an_institutional_profile():
    """mcmaster.ca is a university even though the domain does not say so."""
    from academia.reviewer.enrich import email_source_for

    assert (
        email_source_for("https://www.eng.mcmaster.ca/ece/faculty/x", "bilginb@mcmaster.ca")
        == "institutional_profile"
    )
    assert (
        email_source_for("https://somelab.example.org/team", "person@gmail.com")
        == "lab_homepage"
    )


# ------------------------------------------------- supplying a verified rank


def test_lookups_accept_a_rank_with_its_source(tmp_path):
    """A regex cannot read a staff page, but whoever is looking at it can.

    The rank still has to be *found*: it is recorded with the URL that stated
    it, exactly like an address, so a dossier stays checkable.
    """
    import json

    path = tmp_path / "lookups.json"
    path.write_text(
        json.dumps(
            {
                "person-1": {
                    "urls": ["https://www.eng.mcmaster.ca/ece/faculty/dr-berker-bilgin/"],
                    "rank": "associate_professor",
                    "rank_source": "https://www.eng.mcmaster.ca/ece/faculty/dr-berker-bilgin/",
                },
                "person-2": "https://a.edu/x",
            }
        ),
        encoding="utf-8",
    )

    lookups = contact.read_lookups(path)

    assert lookups.urls["person-1"] == [
        "https://www.eng.mcmaster.ca/ece/faculty/dr-berker-bilgin/"
    ]
    assert lookups.urls["person-2"] == ["https://a.edu/x"]
    assert lookups.ranks["person-1"][0] == "associate_professor"
    assert lookups.ranks["person-1"][1].endswith("dr-berker-bilgin/")


def test_doctorate_years_arrive_with_the_page_that_stated_them(tmp_path):
    """Without an enrolment year the doctoral floor has nothing to measure."""
    import json

    path = tmp_path / "lookups.json"
    path.write_text(
        json.dumps(
            {
                "person-1": {
                    "rank": "phd_student",
                    "rank_source": "https://lab.example/people",
                    "phd_start_year": 2022,
                    "doctorate_institution": "Some Uni",
                    "doctorate_source": "https://ieeexplore.ieee.org/document/1",
                }
            }
        ),
        encoding="utf-8",
    )

    institution, year_from, year_to, source = contact.read_lookups(path).doctorates["person-1"]
    assert (institution, year_from, year_to) == ("Some Uni", 2022, None)
    assert source.endswith("/document/1")


def test_a_doctorate_year_without_a_source_is_refused(tmp_path):
    """Same rule as a rank and an address: the claim travels with its page."""
    import json

    from academia.core.errors import UsageError

    path = tmp_path / "l.json"
    path.write_text(json.dumps({"person-1": {"phd_year": 2015}}), encoding="utf-8")

    with pytest.raises(UsageError, match="doctorate_source"):
        contact.read_lookups(path)


def test_an_implausible_doctorate_year_stops_the_run(tmp_path):
    import json

    from academia.core.errors import UsageError

    path = tmp_path / "l.json"
    path.write_text(
        json.dumps({"person-1": {"phd_year": 15, "doctorate_source": "https://a"}}),
        encoding="utf-8",
    )

    with pytest.raises(UsageError, match="plausible year"):
        contact.read_lookups(path)


def test_a_corrected_affiliation_arrives_with_its_page(tmp_path):
    """A bibliographic database can attach someone to the wrong institution."""
    import json

    path = tmp_path / "l.json"
    path.write_text(
        json.dumps(
            {
                "person-1": {
                    "institution": "University of Sheffield",
                    "institution_country": "gb",
                    "institution_source": "https://sheffield.ac.uk/eee/people/x",
                }
            }
        ),
        encoding="utf-8",
    )

    name, country, source = contact.read_lookups(path).affiliations["person-1"]
    assert (name, country) == ("University of Sheffield", "GB")
    assert source.startswith("https://sheffield")


def test_an_affiliation_without_a_source_is_refused(tmp_path):
    import json

    from academia.core.errors import UsageError

    path = tmp_path / "l.json"
    path.write_text(json.dumps({"person-1": {"institution": "Somewhere"}}), encoding="utf-8")

    with pytest.raises(UsageError, match="institution_source"):
        contact.read_lookups(path)


def test_a_rank_without_a_source_is_refused(tmp_path):
    """An unsourced claim about someone's job has no place in a dossier."""
    import json

    from academia.core.errors import UsageError

    path = tmp_path / "l.json"
    path.write_text(json.dumps({"person-1": {"rank": "professor"}}), encoding="utf-8")

    with pytest.raises(UsageError, match="rank_source"):
        contact.read_lookups(path)


def test_an_unrecognised_rank_is_refused_rather_than_ignored(tmp_path):
    """A typo that silently vanishes is worse than one that stops the run."""
    import json

    from academia.core.errors import UsageError

    path = tmp_path / "l.json"
    path.write_text(
        json.dumps({"person-1": {"rank": "assocaite_professor", "rank_source": "https://a"}}),
        encoding="utf-8",
    )

    with pytest.raises(UsageError, match="assocaite_professor"):
        contact.read_lookups(path)


def test_the_worklist_says_what_each_candidate_is_missing(conn):
    person_id = repo.upsert_person(conn, Author(name="Ada Gap", idx=0, openalex_id="A8"))
    repo.store_institution_for(conn, person_id, name="Uni", country_code="GB", is_current=True)
    person = repo.load_person(conn, person_id)

    items = contact.lookup_worklist([person])

    assert items[0]["needs"] == ["email", "position"]


def test_a_candidate_needing_only_a_position_says_so(conn):
    person_id = repo.upsert_person(conn, Author(name="Ada Mail", idx=0, openalex_id="A9"))
    person = repo.load_person(conn, person_id)

    items = contact.lookup_worklist([person], resolved={person_id})

    assert items[0]["needs"] == ["position"]


# --------------------------------------------------------------- PDF path --


def _one_page_pdf(text: str) -> bytes:
    """A real PDF, so the reader is exercised rather than a stub of it."""
    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), text)
    return document.tobytes()


def _three_page_pdf(*texts: str) -> bytes:
    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    for text in texts:
        page = document.new_page()
        page.insert_text((72, 72), text)
    return document.tobytes()


def test_a_footnote_printed_only_in_the_pdf_is_still_found():
    """Publishers render some author blocks nowhere but the PDF itself."""
    body = _one_page_pdf("L. Author is with Some Uni (e-mail: l.author@some.edu).")

    assert contact.looks_like_pdf(body)
    assert "l.author@some.edu" in contact.extract_page_emails(contact.pdf_text(body))


def test_publication_lookup_honours_the_configured_paper_budget(conn):
    person_id = repo.upsert_person(conn, Author(name="Ada Budget", idx=0, openalex_id="A-budget"))
    for index in range(2):
        paper = Paper.build(
            title=f"Paper {index}",
            source="openalex",
            doi=f"10.1/budget-{index}",
            landing_page_url=f"https://example.edu/{index}",
            year=2026 - index,
        )
        paper.authors = [Author(name="Ada Budget", idx=0, openalex_id="A-budget")]
        repo.ingest_paper(conn, paper)
    person = repo.load_person(conn, person_id)
    calls = []

    contact.email_from_publications(
        conn,
        person,
        fetcher=lambda url: calls.append(url) or "",
        max_papers=1,
    )

    assert calls == ["https://example.edu/0"]


def test_pdf_fallback_reads_only_the_front_page():
    body = _three_page_pdf(
        "front matter front@uni.edu",
        "manuscript body body@uni.edu",
        "author biography back@uni.edu",
    )

    text = contact.pdf_text(body)

    assert "front@uni.edu" in text
    assert "body@uni.edu" not in text
    assert "back@uni.edu" not in text


def test_html_bytes_are_not_mistaken_for_a_pdf():
    assert not contact.looks_like_pdf(b"<html><body>hi</body></html>", "text/html", "https://a/b")


def test_a_url_ending_in_pdf_is_treated_as_one_even_without_a_content_type():
    assert contact.looks_like_pdf(b"", "", "https://repo.example/paper.pdf?download=1")


def test_the_fetcher_decodes_html_and_extracts_pdfs():
    from academia.reviewer.enrich import PageFetcher

    pdf = _one_page_pdf("contact: someone@uni.edu")
    fetcher = PageFetcher(
        getter=lambda url, source, timeout=15: (pdf, "application/pdf", url), delay=0
    )
    assert "someone@uni.edu" in fetcher("https://repo.example/p.pdf")

    html = PageFetcher(
        getter=lambda url, source, timeout=15: (b"<p>a@b.edu</p>", "text/html", url), delay=0
    )
    assert "a@b.edu" in html("https://example.edu/staff")


def test_an_all_initials_local_part_is_a_weak_match():
    """"gww" is Geng Wei Wei, and "ys" is Yilmaz Sozer.

    An address that is nothing but the person's initials is the ordinary form on
    Chinese university staff pages and on plenty of US ones. Scoring it zero
    discarded a correct address that was sitting in plain sight on the page we
    had already fetched. It is only ever *weak*: on a directory listing, initials
    collide even more readily than surnames do, so the sole-match rule still
    decides whether it is used.
    """
    from academia.reviewer.enrich import match_strength

    geng = Person(person_id="p", display_name="Weiwei Geng")
    assert match_strength("gww@njust.edu.cn", geng) == 1

    sozer = Person(person_id="p", display_name="Yilmaz Sozer")
    assert match_strength("ys@uakron.edu", sozer) == 1


def test_initials_belonging_to_someone_else_are_not_a_match():
    from academia.reviewer.enrich import match_strength

    geng = Person(person_id="p", display_name="Weiwei Geng")
    assert match_strength("apsc-zzr@nuaa.edu.cn", geng) == 0
    assert match_strength("gg@example.edu", geng) == 0


def test_a_sole_initials_address_on_a_staff_page_is_accepted():
    from academia.reviewer.enrich import match_email_to_person

    geng = Person(person_id="p", display_name="Weiwei Geng")
    page = ["apsc-zzr@nuaa.edu.cn", "gww@njust.edu.cn"]

    assert match_email_to_person(page, geng) == "gww@njust.edu.cn"


def test_a_package_version_is_not_an_address():
    """"bootstrap@5.1.3" sits in the <script> tags of most modern staff pages.

    It has the shape of an address and none of the substance. A real top-level
    domain is alphabetic, which is enough to tell the two apart.
    """
    from academia.reviewer.enrich import extract_emails

    page = "bootstrap@5.1.3 jquery-ui@6.0 ys@uakron.edu"

    assert extract_emails(page) == ["ys@uakron.edu"]


def test_an_editor_supplied_url_is_read_even_when_an_address_is_already_stored(tmp_path):
    """Handing back a better URL is the documented way to correct an address.

    ``discover_email`` short-circuited on anything already in the database, so
    the correction was fetched, matched — and then never looked at, because the
    function had returned several lines earlier. The stale address stayed put no
    matter how many times the editor re-ran enrich with the right page.
    """
    from academia.core.models import Author
    from academia.reviewer.enrich import discover_email
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "e.db")
    person_id = repo.upsert_person(
        conn, Author(name="Zaixin Song", idx=0, orcid="0000-0002-0599-3350")
    )
    person = Person(person_id=person_id, display_name="Zaixin Song")
    repo.record_email(
        conn, person_id, "zaixisong2@cityu.edu.hk",
        source="orcid_public", confidence=0.7,
    )

    finding = discover_email(
        conn, person,
        fetcher=lambda url: "zaixin.song@polyu.edu.hk",
        extra_urls=["https://www.polyu.edu.hk/ise/people/academic-staff/zaixin-song/"],
    )

    assert finding.email == "zaixin.song@polyu.edu.hk"
    assert finding.source == "institutional_profile"


def test_every_address_found_is_kept_not_only_the_chosen_one(tmp_path):
    """A candidate often has two live addresses and the choice is the editor's.

    The corresponding-author footnote proves an address was theirs when the
    paper went out; the staff page of where they work now proves where they read
    mail today. Those disagree for anyone who has moved, so one pass that sees
    both has to store both — the report shows them side by side rather than
    silently discarding the one that lost on precedence.
    """
    from academia.core.models import Author
    from academia.reviewer.enrich import discover_email
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "both.db")
    person_id = repo.upsert_person(
        conn, Author(name="Zaixin Song", idx=0, orcid="0000-0002-0599-3350")
    )
    person = Person(person_id=person_id, display_name="Zaixin Song")

    pages = {
        "https://www.polyu.edu.hk/ise/people/academic-staff/zaixin-song/": "zaixin.song@polyu.edu.hk",
        "https://songlab.example.org/team": "zaixisong2@cityu.edu.hk",
    }
    discover_email(
        conn, person, fetcher=pages.get, extra_urls=list(pages),
    )

    stored = {row["email"] for row in repo.emails_of(conn, person_id)}
    assert stored == {"zaixin.song@polyu.edu.hk", "zaixisong2@cityu.edu.hk"}


def test_a_settled_address_is_not_re_crawled_every_run(tmp_path, monkeypatch):
    """Re-reading every candidate's papers on every run costs minutes.

    The reason to look again is that the editor handed back a URL to look at.
    With nothing new supplied, what is already stored is the answer, and enrich
    stays as cheap on the tenth run as on the first.
    """
    from academia.core.models import Author
    from academia.reviewer import contact as contact_module
    from academia.reviewer.enrich import discover_email
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "settled.db")
    person_id = repo.upsert_person(
        conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097")
    )
    person = Person(person_id=person_id, display_name="Ada Researcher")
    repo.record_email(
        conn, person_id, "ada@uni.edu",
        source="institutional_profile", source_url="https://uni.edu/ada", confidence=0.9,
    )

    def refuse(*args, **kwargs):
        raise AssertionError("papers were re-crawled for a settled address")

    monkeypatch.setattr(contact_module, "email_from_publications", refuse)

    finding = discover_email(conn, person, fetcher=lambda url: "")

    assert finding.email == "ada@uni.edu"


def test_a_supplied_url_still_reopens_a_settled_address(tmp_path):
    """The saving above must not switch the correction path back off."""
    from academia.core.models import Author
    from academia.reviewer.enrich import discover_email
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "reopen.db")
    person_id = repo.upsert_person(
        conn, Author(name="Zaixin Song", idx=0, orcid="0000-0002-0599-3350")
    )
    person = Person(person_id=person_id, display_name="Zaixin Song")
    repo.record_email(
        conn, person_id, "zaixisong2@cityu.edu.hk", source="orcid_public", confidence=0.7,
    )

    finding = discover_email(
        conn, person,
        fetcher=lambda url: "zaixin.song@polyu.edu.hk",
        extra_urls=["https://www.polyu.edu.hk/ise/people/academic-staff/zaixin-song/"],
    )

    assert finding.email == "zaixin.song@polyu.edu.hk"
