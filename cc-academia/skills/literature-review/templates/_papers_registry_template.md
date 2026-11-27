# Papers Registry — paper citation map

`generated: <date>` · **The single citation source**. Every report/card cites by **ShortRef** (author + year); never by hash.

> **Rules**
> 1. Report bodies always use `[Author et al. YYYY]` or `Author (YYYY)`.
> 2. Filename = `<author-lastname>-<year>_card.md` (with several authors take the first; same author and year get a distinguishing suffix).
> 3. `candidate_id` (hash) is only for CLI operations (read/acquire/ingest) and **never enters a narrative report**.
> 4. The card template is `../templates/_card_template.md`.
> 5. Append one row for every included paper added.

| ShortRef | Filename | candidate_id (internal only) | Title | Authors | Year | Venue |
|----------|----------|----------------------|-------|---------|------|-------|
| **<AuthorLastname> et al. <year>** | `<lastname>-<year>_card.md` | S2-<hash> | <Title> | <Authors> | <year> | <venue> |
