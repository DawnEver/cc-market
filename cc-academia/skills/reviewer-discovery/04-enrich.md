# 04 — Enrich

Fill in where each candidate works, how they got there, and how to reach them.

```bash
uv run --project "<plugin-root>" rev-disc enrich --slug <slug> --limit 40 --json
```

Background and contact details are one step because they share a source. ORCID
carries an education section for only about 30% of researchers in this field —
measured on a live sample, not assumed — so an institutional page usually has to
be fetched anyway, and that single fetch yields both the address and the degree
history, backed by the same URL.

## Which pages get read

**Only pages the researcher published themselves.** The URLs come from the
`researcher-urls` section of their own public ORCID record; nothing here
searches the open web for a person. That is what makes the fetch defensible: the
tool reads a page its subject chose to publish, at one request per second, and
stops touching a host after two consecutive failures rather than retrying.

When ORCID lists no URL but you can see a staff page, supply it:

```bash
uv run --project "<plugin-root>" rev-disc enrich --slug <slug>   --homepage <person_id>=https://www.example.edu/staff/name
```

`--no-email` skips contact discovery entirely; only the scholarly APIs are then
contacted.

## Closing the gap — the step you have to do

Structured sources reach roughly a fifth of candidates in this field, and that
ceiling was measured, not assumed:

| Source | Result |
|--------|--------|
| Public ORCID address | works — most of the automatic yield |
| ORCID `researcher-urls` → institutional page | works, but few researchers list a URL |
| Open-access **landing page** | IEEE, MDPI and IET answer `403`; Springer works |
| Open-access **PDF** | `403` from MDPI, `502` from IEEE |
| Repository copy | none exist for this field's papers |
| Crossref author metadata | 0 addresses in 8 records |

So the rest needs a search — which the CLI cannot do and has no business
guessing at. **That step is yours.** Run:

```bash
uv run --project "<plugin-root>" rev-disc contacts --slug <slug> --json
```

It returns every candidate with something still missing — `needs` is `email`,
`position`, or both — along with their institution and a suggested query. Search
for each one's staff page and hand back what you found:

```json
{
  "person-8e8ea1e0efc0971b": ["https://www.uwindsor.ca/engineering/electrical/328/dr-narayan-kar"],
  "person-757153134717aca0": {
    "urls": ["https://sparklab.engr.uky.edu/people"],
    "rank": "phd_student",
    "rank_source": "https://sparklab.engr.uky.edu/people"
  }
}
```

A rank must come with `rank_source`, the URL of the page that states it — an
unsourced claim about someone's job has no place in a dossier. An unrecognised
rank stops the run rather than being silently dropped.

```bash
uv run --project "<plugin-root>" rev-disc enrich --slug <slug>   --homepages homepages.json --json
```

**Give it the URL, never the address.** Even if the search snippet shows the
address, pass the page — the CLI fetches it, extracts, and checks the name
against the local part. That is what keeps "found, never generated" true when a
model is in the loop, and it is why a snippet that has gone stale cannot become
an invitation.

On the live TTE run this took 10 of 47 candidates to 14, including the four
highest-ranked, in one pass of four searches.

## Academic position

The pool is harvested from authorship, so it contains PhD and MSc students by
construction. On the live TTE run **two of the top ten were PhD candidates**,
and one of them was reported as "Engineer" because his only ORCID employment was
an industry post. Students are flagged with "confirm before inviting" and kept
on the list — a late-stage doctoral researcher may be right on a narrow topic,
but the editor has to be told before an invitation goes out.

Positions come from ORCID `role-title`, which covers roughly half. Reading the
rank out of a fetched page automatically was tried and removed: anchoring a text
window on the person's name returned "MSc student" for an associate professor
whose page mentions supervising graduate students, and "unknown" for a full
professor whose page states the title above the name. A confidently wrong rank
is worse than a blank one. So the remainder comes back through the worklist
above, read by someone who can actually see the page.

A rank you supply is authoritative and overrides the career record. A title that
maps to none of the standard ranks is shown verbatim, so "unknown" means nobody
stated anything at all.

## Attributing an address to the right person

A department directory lists dozens of addresses and several people with the
same surname. So a *weak* match — the surname alone — is only accepted when it
is the sole match on the page. A *strong* match carries more: two name parts
(`guohai.liu`), or an initial and the surname (`ghliu`). Faced with
`wei.liu@` and `hui.liu@` on one page, the tool reports nothing rather than
picking one.

## What gets filled in

| Field | Source | Coverage |
|-------|--------|----------|
| Current institution and country | OpenAlex, ROR-linked | high |
| Career history with years | OpenAlex affiliation series | high |
| Degrees and alma mater | ORCID education | around 30% |
| Doctoral supervisor | direct textual evidence only | low |
| Public email | institutional page > lab page > public ORCID | ~20% |

The precedence is deliberately not cheapest-first. An address on someone's own
institutional profile is the one they maintain; the ORCID field is frequently
years out of date. `published_corresponding` ranks above all of these and is
honoured when present, but **no wired source supplies it today** — OpenAlex does
not expose author addresses. It is there for an address an editor records by
hand from the manuscript itself.

## Rules that are not negotiable

- **No address is ever generated from a pattern.** `firstname.lastname@uni.edu`
  is a guess that either bounces or reaches a stranger, and the editor cannot
  tell which. Missing is recorded as `not_found`.
- **Unknown stays unknown.** An empty education section is a gap in public data,
  not a fact about the person, and it never counts against them.
- **Every stored field carries its source URL**, because a dossier has to be
  checkable.
- ORCID is not an email directory. Addresses there default to private, and only
  ones the researcher chose to publish are ever read.

## Reporting to the user

Say plainly how many candidates got an email and how many got a career history.
Poor email coverage is a fact about public data, not a failure of the run — and
the editor can often still reach people through the editorial system.
