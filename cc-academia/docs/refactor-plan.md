# cc-academia reviewer-discovery — refactoring plan

Written 2026-08-30 from a live end-to-end run of `tte-2026-08-2905` on a second
workstation. Every number below was measured on that run, not estimated. The
plan is meant to be executed by an agent that has not seen that session, so it
states current state, evidence, and acceptance criteria for each item.

Repository: `cc-market/cc-academia` (plugin `cc-academia`, currently v0.1.14).
CI runs `ruff check .`, `python scripts/release.py --check`, `pytest -q` — all
three from the `cc-academia/` directory. Run all three before every commit; CI
was already red on `b6c30dd` for pre-existing lint, so do not assume green.

## The one architectural idea this plan is built on

The workflow answers two questions with completely different failure modes, and
most of the pain comes from managing them as if they were one:

```
ELIGIBILITY  submission → queries → papers → authorships → candidates → COI → rank
             closed world. Data is in the store. Exhaustible, re-runnable,
             verifiable. A gap here is a bug.

REACHABILITY candidate → {ORCID | paper front matter | institutional page}
                        → email, rank, doctorate year
             open world. Targets are scattered across the public web. No
             completion criterion exists. A gap here may be a bug or may be
             the truth about public data, and today nothing can tell them apart.
```

Every phase below is either "make the closed world actually closed" or "make the
open world's incompleteness visible". Where a change blurs the two, prefer the
one that keeps them separate.

## Non-negotiable invariants — do not regress these

These are load-bearing and several are the whole point of the project. A change
that breaks one is wrong even if it improves a metric.

1. **Reviewers are discovered as authors of related work, never by asking a model
   for names.** No phase here introduces model-generated candidates.
2. **No address is ever constructed from a pattern.** `first.last@uni.edu` is a
   guess that either bounces or reaches a stranger. Missing is `not_found`.
3. **A model never decides a conflict of interest.** COI verdicts stay
   deterministic, with a rule and a citation.
4. **Every stored field carries its source URL.** The sole exception is an
   explicit `editor_attestation`, labelled as such.
5. **Unknown stays unknown.** An empty ORCID education section is a gap in public
   data, not a fact about the person, and never counts against them.
6. **Give the CLI a URL, never an address.** Even when a search snippet shows the
   address, hand over the page; the CLI fetches, extracts, and name-checks it.
7. **Wording discipline**: "no detected conflict", never "no conflict".

## Phase 0 — stop the silent failures (do this first, it is small)

Nothing downstream can be trusted while these stand. Both produce wrong output
with a plausible shape, which is worse than crashing.

### 0.1 `--json` truncates on non-ASCII (Windows)

`core/log.py:39` `emit()` does `json.dump(..., ensure_ascii=False)` to
`sys.stdout`. On Windows stdout is cp1252, so a candidate named `Gökhan Çakal`
(U+0131) raises `UnicodeEncodeError` **mid-write**, leaving a truncated,
unparseable file and exit 1.

This shipped undetected because the 21-candidate pool was all-ASCII; the
50-candidate pool is not. It matters more than it looks: `rev-disc contacts
--json` is what drives the agent-owned lookup step, so a broken worklist silently
under-reports the work remaining — the exact failure this whole plan is about.

- Reconfigure stdout **and** stderr to UTF-8 at the CLI entry point
  (`cli/dispatch.py`), e.g. `sys.stdout.reconfigure(encoding="utf-8")`. Keep
  `ensure_ascii=False`; readable non-ASCII is correct, the stream was wrong.
- Do not "fix" this by setting `ensure_ascii=True`. That hides the mangling in
  stdout and leaves the human stream on stderr still broken.
- **Test**: a candidate named `Gökhan Çakal` round-trips through `contacts
  --json` and `report --json` and parses. Assert on the parsed object, not on
  bytes.
- **Acceptance**: `PYTHONIOENCODING` unset, a non-ASCII name present, exit 0 and
  valid JSON.

### 0.2 The agent-owned lookup step has no completion state

`contacts` returns everyone still missing something. Nothing records who was
already searched, so these two are indistinguishable in every artifact:

- nobody ever looked for this person, and
- somebody looked and public data genuinely has nothing.

Measured on the live run: 31 candidates still missing something, **28 of whom
were never searched at all** — and no file anywhere says so. `homepages.json`
records only *selected* URLs, never attempts or dead ends.

This is the same defect class as the `candidates` empty-pool bug fixed in
`314f4eb`, but at the agent layer.

- Persist an attempt log per workspace, e.g.
  `4-audit/lookups.jsonl`: `person_id`, `searched_at`, `queries`, `urls_seen`,
  `urls_selected`, `outcome` ∈ `{found, no_public_data, blocked, skipped}`.
- `contacts --json` gains `searched: bool` and `last_outcome` per person, and a
  summary `{missing, resolved, never_searched}`.
- `report` surfaces `never_searched` count and refuses to describe coverage as
  final while it is non-zero (a warning, not a hard failure).
- **Test**: a workspace where 2 of 5 are logged as searched-and-empty reports
  `never_searched: 3`, and those 3 are distinguishable from the 2 in output.
- **Acceptance**: from the artifacts alone, a reader can tell what was never
  attempted. This is the single highest-value item in the plan.

## Phase 1 — measure before building (spike, ~half a day, no production code)

I recommended "implement the IEEE author-biography parser" as highest-ROI and
**that recommendation was wrong**; the data does not support it. Do not build the
parser until this spike says to.

`contact.py:105-107` fetches the last two pages of each PDF specifically for the
IEEE author biography — "the one paragraph that states both a rank and a
doctorate year" (commit `64c31fc`). `pdf_text()` renders those pages and then
only `extract_page_emails()` runs over the text. The rank and doctorate year are
downloaded, rendered, and discarded. So today the corpus pays the fetch cost for
a capability that was never finished.

But the accessible corpus may not contain bios at all:

| Measured on 1187 papers | Count |
|---|---|
| with a `pdf_url` | 599 |
| of those, `ieeexplore.ieee.org` (which answers 403) | 109 |
| `mdpi.com` (403) | 58 |
| IOP / ScienceDirect / Wiley / APS / Nature / arXiv | the bulk of the rest |
| non-IEEE PDFs sampled that contained a `received the …` bio | **0 of 12** |

Author biographies are largely an IEEE Transactions convention, and IEEE PDFs are
exactly the ones that refuse us.

**Spike task**: over a stratified sample of ≥60 papers that actually fetch,
report how many contain a parseable biography, and how many of those belong to a
candidate whose rank is currently `unknown`. That last number is the yield.

- Yield ≥ 15 candidates → build the parser (Phase 2.1).
- Yield < 5 → **delete `PDF_BACK_PAGES` and stop fetching the back pages**, and
  correct the docstrings in `contact.py` and `04-enrich.md` that promise a
  capability the corpus cannot support. Removing dead cost is a real result.
- In between → keep the fetch, build the parser only if it is cheap.

Write the finding into `docs/` as a short measured note either way. Do not let
this spike quietly become a rewrite.

## Phase 2 — close the reachability gap with what the data supports

### 2.1 Author-biography parser (only if Phase 1 says so)

Gated on the spike. If built:

- Parse **only** the formulaic IEEE bio sentence shapes ("received the Ph.D.
  degree ... from ... in YYYY", "is currently an Associate Professor with ...").
  Anchor on the biography section, not on a text window around a name.
- **Precedent to respect**: reading a rank off a *staff page* by anchoring a text
  window on the person's name was tried and removed — it returned "MSc student"
  for an associate professor whose page mentions supervising students. That
  rejection was correct and this is not a licence to retry it. An IEEE bio is a
  different target: fixed position, fixed grammar, one person per paragraph.
- A confidently wrong rank is worse than a blank one. Emit nothing below high
  confidence. `rank_source` is mandatory.
- **Test**: real bio fixtures (commit the text, not the PDFs) covering professor,
  associate professor, PhD student, and an industry post. Plus a negative: a bio
  that mentions a co-author's title must not be attributed to the subject.

### 2.2 Wire the unused sources

`sources/` contains `semantic_scholar.py`, `dblp.py`, `arxiv.py`. The
reviewer-discovery registry (`cli/rev_disc.py:80` `_sources`) is
`{openalex, ieee}` only. On the live run IEEE contributed **62 of 1187 papers
(5%)**, so the corpus is effectively single-source OpenAlex.

- Add Semantic Scholar to the registry; it has strong recall in this field and an
  adapter already exists.
- Separately, diagnose why IEEE yields 5% — throttling, key, or query shape. Do
  not paper over it by dropping IEEE; find out.
- **Test**: registry composition is asserted, and an unknown `--source` still
  raises `UsageError`.
- **Acceptance**: report per-source paper counts so a collapsed source is
  visible instead of silently halving recall.

### 2.3 Address recency

`enrich.py:55` `EMAIL_PRECEDENCE` puts `published_corresponding` above
`institutional_profile` unconditionally. A footnote proves the address was theirs
when the paper shipped; it necessarily predates any move since. Observed: Zaixin
Song offered a stale CityU address while at PolyU; Hang Zhao offered
`hangzhao5-c@my.cityu.edu.hk`, a *student* address at the university he left.

A first mitigation shipped in `5d01dec`: every address found is stored, and
`shortlist.csv` carries `email_alternate` + source, so the editor sees both. That
was the user's explicit choice over re-ordering precedence, **and it should not
be silently overturned** — confirm before changing it.

Remaining work, if the editor wants more:
- Only one alternate is surfaced today; a person may have more than two.
- Consider a *recency signal* rather than a precedence flip: mark an address
  whose domain does not match the current institution. Present it; do not
  auto-demote without the editor's say-so.

## Phase 3 — make the retrieval layer configurable

The codebase holds two very different standards. The COI / eligibility / scoring
layer is exemplary: `configs/coi.toml` plus per-journal overlays, uniform
`off | prefer | require` modes, `ACADEMIA_CONFIG_DIR` to override the whole
directory, every value documented with its rationale. Do not disturb it — use it
as the model.

The retrieval and enrichment layer has **no configuration at all**. These are
bare module constants with no CLI flag and no TOML key:

| Constant | Location | Value |
|---|---|---|
| `MAX_PAPERS_PER_CANDIDATE` | `contact.py:51` | 4, applied as an inline `[:4]` slice at line 200 |
| `PDF_FRONT_PAGES` / `PDF_BACK_PAGES` | `contact.py:106-107` | 1 / 2 |
| `PAGE_REQUEST_DELAY` | `enrich.py:344` | 1.0 s |
| `HOST_FAILURE_BUDGET` | `enrich.py:341` | 2 |
| `MAX_PAGE_BYTES` | `enrich.py:336` | 400 000 |
| `EMAIL_CONFIDENCE` / `EMAIL_PRECEDENCE` | `enrich.py:44,55` | four fixed tiers |
| `--pool` / `--top-papers` | `cli/dispatch.py:138-139` | 300 / 50, CLI-only |

The configuration effort went into the layer an editor rarely touches, and none
into the layer they touch constantly. Both live requests in the session that
produced this plan — change email precedence, widen the candidate pool — landed
in the unconfigurable half. The first required editing source; the second
required a blind parameter sweep, because `top-papers → candidate count` is
non-obvious (measured: 50→21, 100→44, 110→50, 200→109, 400→225).

- Add a `[retrieval]` section to `coi.toml` (or a sibling `retrieval.toml` if
  mixing policy with mechanics is objectionable — argue it either way, but pick
  one), journal-overridable through the same loader.
- Keep the module constants as defaults so nothing breaks unset.
- `--top-papers` is a poor control surface. Consider expressing the intent
  directly — a target candidate count, or a minimum evidence threshold — and let
  the code solve for the paper count. If that is too clever, at least document
  the measured mapping above.
- **Test**: a journal overlay that changes `max_papers_per_candidate` takes
  effect; an unset key falls back to the module default.

## Phase 4 — elegance, once behaviour is settled

Do not start here; these are real but cosmetic beside Phase 0.

- `contact.py` mixes three concerns: HTTP/PDF mechanics, address attribution, and
  the manual-bridge worklist/`Lookups` schema. The third is a different subsystem
  and could move out.
- If Phase 1 kills the bio, `looks_like_pdf` / `pdf_text` / `PDF_*` shrink
  considerably.
- `report.py` `SHORTLIST_COLUMNS` is now 48 columns wide. It is meant to be
  spreadsheet-friendly, which justifies width, but the email block (5 columns)
  and any Phase 2.3 additions deserve a second look.

## Sequencing and stopping rules

```
Phase 0  →  Phase 1 (spike)  →  Phase 2  →  Phase 3  →  Phase 4
   ↑ do this even if nothing else gets done
```

Phase 0 is worth doing alone and is the only phase with no judgement calls in it.
Phase 1 is a decision gate, not construction — if it returns a low yield, deleting
code is the correct outcome and the plan has succeeded.

Do not batch these into one commit. Each numbered item is one commit with its own
tests, TDD: failing test first, simplest pass, then refactor.

## Things to verify rather than trust

The plan's author had a live workspace and this document does not. Re-measure
before acting on any number here. In particular:

- The 1187-paper corpus came from `search --pages 5 --per-page 50`; a different
  search shape changes every ratio in Phase 1.
- Coverage figures (23 of 50 with an address) reflect a run where only 21
  candidates had ever been hand-searched. They are not a ceiling on what the
  tooling can reach.
- The store is machine-local by design and is not synced. A workspace that
  arrived from another machine has stage-completion markers in `run_state.json`
  with no matching rows in SQLite; two bugs of exactly that shape were fixed in
  `5d01dec` and `314f4eb`, and a third may be waiting in a stage nobody re-ran.
  Re-run the whole pipeline on the machine in hand before concluding anything.
