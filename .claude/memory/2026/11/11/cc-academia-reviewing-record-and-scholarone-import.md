---
name: cc-academia-reviewing-record-and-scholarone-import
description: "Reviewing record + ScholarOne import on feat branch; missing-evidence-passes flaw"
metadata:
  type: project
---

# cc-academia: reviewing record + ScholarOne import (2026-11-11)

Branch `feat/reviewer-scholarone-import` (unpushed; suite + ruff green).

- Generic per-candidate signals in enrich: ORCID public peer-reviews
  (`Orcid.get_peer_reviews`; total, by journal via OpenAlex ISSN lookup,
  12-month count, days since last), reviewed-for-target-journal via journal
  config `issns`, 5-year OpenAlex article count, our invitation load from the
  store. Unknown is blank, never zero.
- `rev-disc import-scholarone --slug S <html>`: Locator candidates (match ORCID >
  stored email > unique name), Locator metrics (WoS reviews, load, R-Score —
  no public source, shown only when imported), invitee statuses into the
  invitation record; already-invited excluded from contact list.
- Hint-only review-record check, thresholds in `[reviewing.record_check]`.
- `[retrieval] search_window_years` (default 0). Sheets: decision, audit,
  reviewer list, works, columns. Test fixture is synthetic only.
- Never scrape webofscience.com / reviewerlocator (login, ToS).

Open defects found on the real run:
1. "Missing evidence passes": Locator-only candidates have no evidence so the
   related-journal floor abstains and they reach Check first, while harvested
   people with 1-2 papers are excluded. Proposed fix: fetch their works and
   score them through the same evidence path; no data -> check by hand.
2. 0 candidates found by both ours and Locator despite 565 papers — check
   cross-source author matching ("Last, First", missing ORCID).
