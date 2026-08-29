-- cc-academia accumulating store.
--
-- Append-mostly: papers/persons/authorships are upserted, run artefacts are only
-- ever appended. Every run makes the next one cheaper and better informed.
--
-- Confidentiality: manuscripts are recorded by hash and country only. Titles and
-- abstracts of papers under review never enter this database.

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ---------------------------------------------------------------- papers ----

CREATE TABLE IF NOT EXISTS papers (
    paper_id       TEXT PRIMARY KEY,
    doi            TEXT,
    title          TEXT NOT NULL,
    abstract       TEXT,
    year           INTEGER,
    venue          TEXT,
    venue_type     TEXT,
    citation_count INTEGER,
    source         TEXT NOT NULL,
    source_id      TEXT,
    url            TEXT,
    pdf_url        TEXT,
    landing_page_url TEXT,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi) WHERE doi IS NOT NULL AND doi <> '';
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    title,
    abstract,
    content = 'papers',
    content_rowid = 'rowid',
    tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS papers_fts_insert AFTER INSERT ON papers BEGIN
    INSERT INTO papers_fts(rowid, title, abstract) VALUES (new.rowid, new.title, new.abstract);
END;
CREATE TRIGGER IF NOT EXISTS papers_fts_delete AFTER DELETE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract)
    VALUES ('delete', old.rowid, old.title, old.abstract);
END;
CREATE TRIGGER IF NOT EXISTS papers_fts_update AFTER UPDATE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract)
    VALUES ('delete', old.rowid, old.title, old.abstract);
    INSERT INTO papers_fts(rowid, title, abstract) VALUES (new.rowid, new.title, new.abstract);
END;

-- OpenAlex keywords carry a relevance score; IEEE controlled terms do not.
CREATE TABLE IF NOT EXISTS paper_terms (
    paper_id TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
    term     TEXT NOT NULL,
    kind     TEXT NOT NULL,
    score    REAL,
    PRIMARY KEY (paper_id, term, kind)
);
CREATE INDEX IF NOT EXISTS idx_paper_terms_term ON paper_terms(term);

CREATE TABLE IF NOT EXISTS paper_refs (
    paper_id            TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
    referenced_paper_id TEXT NOT NULL,
    PRIMARY KEY (paper_id, referenced_paper_id)
);
CREATE INDEX IF NOT EXISTS idx_paper_refs_target ON paper_refs(referenced_paper_id);

CREATE TABLE IF NOT EXISTS paper_embeddings (
    paper_id TEXT PRIMARY KEY REFERENCES papers(paper_id) ON DELETE CASCADE,
    model    TEXT NOT NULL,
    dim      INTEGER NOT NULL,
    vec      BLOB NOT NULL
);

-- --------------------------------------------------------------- people ----

CREATE TABLE IF NOT EXISTS persons (
    person_id         TEXT PRIMARY KEY,
    display_name      TEXT NOT NULL,
    orcid             TEXT,
    openalex_id       TEXT,
    ieee_author_id    TEXT,
    s2_id             TEXT,
    confidence        REAL NOT NULL DEFAULT 0.0,
    resolution_method TEXT NOT NULL DEFAULT 'unresolved',
    first_seen        TEXT NOT NULL,
    last_seen         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_orcid ON persons(orcid) WHERE orcid IS NOT NULL AND orcid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_openalex ON persons(openalex_id) WHERE openalex_id IS NOT NULL AND openalex_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_ieee ON persons(ieee_author_id) WHERE ieee_author_id IS NOT NULL AND ieee_author_id <> '';

-- A rank read from a page, kept beside the career history rather than merged
-- into it: a page states what someone is now, an employment record states what
-- they were appointed as, and the report shows whichever is more senior.
CREATE TABLE IF NOT EXISTS person_ranks (
    person_id  TEXT PRIMARY KEY REFERENCES persons(person_id) ON DELETE CASCADE,
    rank       TEXT NOT NULL,
    source_url TEXT,
    seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_names (
    person_id    TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    name_variant TEXT NOT NULL,
    PRIMARY KEY (person_id, name_variant)
);
CREATE INDEX IF NOT EXISTS idx_person_names_variant ON person_names(name_variant);

-- Research topics as the sources report them. Persisted rather than held on the
-- in-memory Person because `coi` and `report` are separate commands that reload
-- every candidate; without this the topic and method score components read
-- empty and contribute nothing.
CREATE TABLE IF NOT EXISTS person_topics (
    person_id TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    term      TEXT NOT NULL,
    source    TEXT NOT NULL,
    seen_at   TEXT NOT NULL,
    PRIMARY KEY (person_id, term, source)
);
CREATE INDEX IF NOT EXISTS idx_person_topics_term ON person_topics(term);

-- idx is the 0-based position in the author list. OpenAlex only labels
-- first/middle/last and its corresponding-author field is routinely empty, so the
-- index is the authoritative signal and position/is_corresponding are hints.
CREATE TABLE IF NOT EXISTS authorships (
    paper_id         TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
    person_id        TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    idx              INTEGER NOT NULL,
    position         TEXT,
    is_corresponding INTEGER NOT NULL DEFAULT 0,
    position_weight  REAL NOT NULL DEFAULT 0.4,
    PRIMARY KEY (paper_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_authorships_person ON authorships(person_id);

-- --------------------------------------------------- institutions & career ----

CREATE TABLE IF NOT EXISTS institutions (
    inst_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    ror_id       TEXT,
    country_code TEXT,
    city         TEXT,
    type         TEXT
);
CREATE INDEX IF NOT EXISTS idx_institutions_country ON institutions(country_code);

CREATE TABLE IF NOT EXISTS affiliations (
    person_id  TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    inst_id    TEXT NOT NULL REFERENCES institutions(inst_id) ON DELETE CASCADE,
    department TEXT,
    role       TEXT,
    year_from  INTEGER,
    year_to    INTEGER,
    is_current INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL,
    source_url TEXT,
    PRIMARY KEY (person_id, inst_id, year_from)
);
CREATE INDEX IF NOT EXISTS idx_affiliations_person ON affiliations(person_id);

CREATE TABLE IF NOT EXISTS education (
    person_id         TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    inst_id           TEXT NOT NULL REFERENCES institutions(inst_id) ON DELETE CASCADE,
    degree            TEXT,
    field             TEXT,
    year_from         INTEGER,
    year_to           INTEGER,
    advisor_person_id TEXT,
    source            TEXT NOT NULL,
    source_url        TEXT,
    PRIMARY KEY (person_id, inst_id, degree)
);
CREATE INDEX IF NOT EXISTS idx_education_person ON education(person_id);

CREATE TABLE IF NOT EXISTS coauthor_edges (
    a_person_id TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    b_person_id TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    paper_count INTEGER NOT NULL DEFAULT 0,
    first_year  INTEGER,
    last_year   INTEGER,
    PRIMARY KEY (a_person_id, b_person_id)
);
CREATE INDEX IF NOT EXISTS idx_coauthor_b ON coauthor_edges(b_person_id);

-- ------------------------------------------------------- reviewer discovery ----

-- Only a hash of the manuscript title is stored. The manuscript itself never
-- enters the database.
CREATE TABLE IF NOT EXISTS manuscripts (
    ms_id            TEXT PRIMARY KEY,
    journal          TEXT,
    title_hash       TEXT NOT NULL,
    origin_countries TEXT,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manuscript_authors (
    ms_id       TEXT NOT NULL REFERENCES manuscripts(ms_id) ON DELETE CASCADE,
    person_id   TEXT,
    name        TEXT NOT NULL,
    affiliation TEXT,
    country     TEXT,
    PRIMARY KEY (ms_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    ms_id       TEXT NOT NULL REFERENCES manuscripts(ms_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    config_hash TEXT
);

CREATE TABLE IF NOT EXISTS candidate_scores (
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    person_id       TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    score           REAL NOT NULL,
    components_json TEXT NOT NULL,
    PRIMARY KEY (run_id, person_id)
);

CREATE TABLE IF NOT EXISTS coi_evidence (
    run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    person_id     TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    rule          TEXT NOT NULL,
    status        TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    checked_at    TEXT NOT NULL,
    PRIMARY KEY (run_id, person_id, rule)
);

CREATE TABLE IF NOT EXISTS emails (
    person_id   TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    source      TEXT NOT NULL,
    source_url  TEXT,
    confidence  REAL NOT NULL DEFAULT 0.0,
    verified_at TEXT NOT NULL,
    PRIMARY KEY (person_id, email)
);

CREATE TABLE IF NOT EXISTS review_history (
    person_id    TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    ms_id        TEXT NOT NULL,
    invited_at   TEXT,
    responded    INTEGER,
    accepted     INTEGER,
    quality_note TEXT,
    PRIMARY KEY (person_id, ms_id)
);
