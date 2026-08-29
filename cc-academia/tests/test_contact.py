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
