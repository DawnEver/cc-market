---
name: review
description: Review a manuscript against the shared review criteria of the knowledge base. Target `own` reviews your own LaTeX draft or edit and returns author-facing revision proposals (lint, review-writing agent, compile, page budget); target `submission` reviews someone else's paper PDF and returns the reviewer report (ingest, consensus, multi-angle fan-out, user draft, polished plain-text comments, archive). Option `rerun <step> <slug>` re-runs one step of a submission review. Use for "review my section", "check the writing", "run the lint", "review this paper", "write the reviewer comments", "re-polish", "re-archive" (including the same requests in Chinese).
allowed-tools: "Read,Write,Bash,Glob,Grep,Agent,Skill,WebFetch,WebSearch,Workflow"
---

# review

One skill, two targets, one set of criteria. The questions a reviewer asks live once in the knowledge base
(`knowledge/<source>/<content>/criteria.tsv`, form `criterion`); `applies` says whether a criterion serves the author
(`self`), the referee of someone else's manuscript (`peer`) or both. The `review-*` agents read them through
`academia-write resolve --task review --scope <part|manuscript> --applies self|peer --angle <angle>` (one line per
criterion; `academia-write explain <id>` for its why); only the procedure differs per target.

Running the CLI: `../_shared/running-the-cli.md`. Host differences: `../_shared/host-adapters.md`.

| Call | Target | Output | Playbook |
|---|---|---|---|
| `review own [files or diff range]` | your own LaTeX draft or edit (the `own.md` chain) | author-facing table of OK / FIX / BLOCK with revision proposals; page count | `own.md` |
| `review submission <pdf or slug>` | someone else's manuscript | `3-response/final.md`, plain-text reviewer comments | `submission.md` (steps `00`-`08`) |
| `review rerun <step> <slug>` | one step of an existing submission review | that step's artefact, never overwriting an archive | `rerun.md` |

Without a target: a `.tex` path, a diff or a LaTeX project with `.academia/profile.tsv` means `own`; a PDF or an
existing slug under `manuscript-review/ongoing/` means `submission`. Ask when it is ambiguous.

## Hard constraint

**Polishing never changes meaning.** Polishing may reorganise, soften, sharpen, rephrase, merge and split, but every
substantive claim traces to a sentence of the reviewer's draft; no new technical claim, citation, number or named
method is added, and an unsourced citation or number in the draft stays as it is. The same holds for `own`: a
proposal never changes the meaning of approved text.

Templates of the submission pipeline (summary, critiques, default angles, reviewer voice) are in `templates/`.
