"""Shared test fixtures for literature-review v2."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def project_root():
    return Path(__file__).resolve().parents[1]


@pytest.fixture
def schemas_dir(project_root):
    return project_root / "literature_review" / "schemas"


@pytest.fixture
def sample_brief():
    return {
        "brief_id": "test-brief",
        "topic_id": "test-topic",
        "artifact_version": 1,
        "created_at": "2026-07-23T00:00:00Z",
        "original_request": "Test research on LLC resonant converters",
        "research_objective": "Find LLC topologies with wide voltage range",
        "inclusion_criteria": ["LLC topology", "Experimental prototype"],
        "exclusion_criteria": ["Low power <100W"],
        "constraints": {
            "year_from": 2018, "year_to": 2026,
            "content_types": ["Journals", "Conferences"],
            "preferred_venues": ["IEEE Transactions on Power Electronics"],
            "defaults_applied": ["year_from", "year_to", "content_types"],
        },
        "concepts": [
            {"concept_id": "c01", "role": "must", "term": "LLC resonant converter",
             "synonyms": ["LLC converter"], "rationale": "Core topology",
             "source": "user", "selected": True},
            {"concept_id": "c02", "role": "should", "term": "wide voltage range",
             "synonyms": ["wide gain range"], "rationale": "Requirement",
             "source": "user", "selected": True},
        ],
        "approval": {"approved": False, "approved_at": None, "approved_by": None,
                     "research_scope_sha256": None},
    }


@pytest.fixture
def sample_candidate():
    return {
        "artifact_version": 1,
        "candidate_id": "IEEE-1234567",
        "source_provider": "ieee_xplore",
        "title": "A Reconfigurable LLC Converter",
        "abstract": "This paper proposes...",
        "doi": "10.1109/TPEL.2024.1234567",
        "authors": ["Zhang, Wei", "Li, Ming"],
        "venue": "IEEE Transactions on Power Electronics",
        "publication_year": 2024,
        "content_type": "Journals",
        "citation_count": 42,
    }
