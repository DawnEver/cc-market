from academia.core.models import Affiliation, Education, Person
from academia.reviewer import trajectory


def person_with_history() -> Person:
    return Person(
        person_id="p1",
        display_name="Ada Researcher",
        affiliations=[
            Affiliation("gb", "University B", "GB", year_from=2022, is_current=True, source="openalex"),
            Affiliation("cn", "University A", "CN", year_from=2016, year_to=2021, source="openalex"),
        ],
        education=[Education("edu", "University C", degree="PhD", year_to=2015, source="orcid")],
    )


def test_trajectory_keeps_current_previous_and_education_distinct():
    steps = trajectory.build(person_with_history())
    assert [(step.kind, step.institution) for step in steps] == [
        ("current", "University B"),
        ("education", "University C"),
        ("publication affiliation", "University A"),
    ]


def test_history_text_does_not_relabel_the_current_country():
    person = person_with_history()
    assert person.country_code == "GB"
    assert "publication affiliation: University A" in trajectory.history_text(person)
    assert "education: University C" in trajectory.history_text(person)


def test_country_exposure_counts_each_person_once_per_country():
    person = person_with_history()
    person.affiliations.append(
        Affiliation("cn2", "University D", "CN", year_to=2014, source="openalex")
    )
    assert trajectory.country_exposure([person], historical=False) == {"GB": 1}
    assert trajectory.country_exposure([person], historical=True) == {"CN": 1}


def test_an_implausibly_broad_bibliographic_history_is_flagged():
    person = person_with_history()
    person.affiliations.extend(
        Affiliation(f"i{i}", f"Institution {i}", "CN", source="openalex")
        for i in range(21)
    )
    assert "requires verification" in trajectory.quality_note(person)
