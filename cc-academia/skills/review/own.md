# review own

Target `own`: your own draft or edit, before it is reported. The output is for the author: proposals, never a
referee report.

Every prose edit passes these steps before it is reported. Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`../_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

1. Writer's change log: old sentence, new sentence, rule id.
2. Mechanical checks: `academia-write lint-prose <changed .tex>`, `academia-write lint-table`, `academia-write check-data`. Fix or
   dismiss every hit with a reason; error-level hits are fixed unless the author ruled otherwise. A wall
   (jurisdiction error, missing profile, missing registry) names its cause and the file to fix: fix that file, never
   bypass the check.
3. Cold review by the `review-writing` agent (never the writer): pass the changed files or diff range and the change
   log. It applies the rules with check `reviewer` and the criteria with `applies` self or both
   (`academia-write resolve --task review --scope <part> --applies self --angle <angle>`), the same criteria the
   `review-*` agents use.
4. Main session: re-read every changed paragraph whole; resolve each FIX; send each BLOCK to the author.
5. Compile with the TeX engine by full path or a verified PATH (e.g. `pdflatex main && bibtex main && pdflatex main &&
   pdflatex main`, or latexmk), keep the output, check the exit status and the log for errors and undefined
   references, and confirm the PDF is newer than the edit. Then `academia-write page-budget` and report the page count;
   over the venue limit: say so at once and offer a compensating cut (rule document.page-limit; write hard constraint 6).
6. Render every changed page to an image and read it; report pages read, page count and PDF time.
7. No commit or push until the author has reviewed and agreed.

Host adaptation: on Codex, read `claude-agents/review-writing.md` and run it as one bounded collaboration subagent
with the same inputs; if none is available, say so and run it locally as an explicit same-model fallback.
