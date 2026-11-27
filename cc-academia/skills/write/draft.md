# Draft a section

For text that does not exist yet (or the author marked as a draft). Revising existing text: `revise.md`.

1. `academia-write resolve --task write --scope <part>` from the LaTeX project root (`explain <id>` for detail). No `.academia/profile.tsv` yet: create it (kind id value
   evidence: venue, field, preset, and project-owned dimensions such as `spelling.variant`). A field with no source:
   run the `field-reading` skill first and draft each section move by move from it; learn structure, never
   wording (no run of more than six words from one paper; stock formulae shared by many papers are conventions). Note every "default used" line in your report.
2. Read the templates for this section: the common moves (`knowledge/common/prose/templates/`), the
   field's `prose/templates/moves.md` and `sentences.md`, the common abstract layers (`knowledge/common/prose/templates/abstract-layers.md`). For the abstract, introduction,
   conclusion and outline, write a reasoning skeleton and show it to the author first (hard constraint 1).
3. Draft move by move; one claim per sentence, each sentence linked to the previous (cohesion.hook-previous). Result
   numbers come from the registry as `\val{id}` (`data.md`). Figures and tables near their discussion
   (figure.placement-near-text).
4. LaTeX setup: one document per directory, each with its own `main.tex`; `\cite{key}`; semantic line breaks.
5. Run `review own` before reporting.
