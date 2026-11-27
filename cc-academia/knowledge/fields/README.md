# Field writing profiles

Each field folder records how one field writes: section moves with counts, slot templates of
recurring sentences, conventions and habits per object type, and review criteria from its weak patterns.
Built by the field-reading workflow (the field-reading skill) from full texts in the user's literature
corpus (`cc-academia` reviews), 2026-11-18. Counts are approximate.

| Profile | Field | Papers read | Reliability |
|---|---|---|---|
| `power-electronics-drives/` | PWM losses, multiphase drives, co-simulation | 46 | sampled sections |
| `electrical-machine-design/` | PM/IPM machine design and optimisation (ICEM, IEEE TEC/TIA) | 67 | mostly deep-read cards |
| `computational-mechanics-optimisation/` | topology optimisation, isogeometric analysis, FEM | 35 | some PDFs extracted poorly |
| `music-information-retrieval/` | MIR, audio ML (ISMIR, ICASSP) | 11 | small corpus, tentative |
| `constraint-path-enumeration/` | reading lens only (`lens.toml`), no writing profile | - | - |

## What all four fields share

All four fields keep the same section skeleton: context, specific problem, prior work, gap,
this paper, then findings. They differ in register and in where numbers go. Five habits appear
in every field; each field's `habits.md` gives its counts and links the related dimension or rule id.

1. Numbered contribution lists and "organized as follows" roadmaps (argument.no-enumerative-scaffolding, introduction.roadmap, structure.no-structure-preview).
2. Announced novelty: "novel", "to the best of our knowledge" (argument.no-announced-novelty).
3. ", which" tails, "while"/"although" contrasts, and "However" as the gap marker (sentence.relative-clause, sentence.no-contrast-join).
4. Personified subjects for papers, methods and models: "results reveal", "the model learns"
   (wording.technical-verbs).
5. Numbers in the abstract: "up to x %", often with the operating point (numbers.abstract-conclusion). This is
   strongest in IEEE Transactions and in MIR benchmark reporting.

A field source describes practice; it never relaxes a common rule (resolve rejects a field row that redefines a
common rule id), and the dimension values that apply come from their owning source.

## Layout of a field source

| File | Holds |
|---|---|
| `README.md` | scope, corpus, exemplary papers |
| `prose/templates/moves.md`, `prose/templates/sentences.md` | section moves with counts; slot templates |
| `<content>/templates/conventions.md` | the field's conventions for that object type (prose, data, figure, table, equation) |
| `<content>/templates/habits.md` | field habits, described neutrally with their frequency, each linked to a dimension or rule id |
| `<content>/criteria.tsv` | review questions from the field's weak patterns (applies both) and, for a field with a reading lens, its review questions |
| `prose/rules.tsv` | real field requirements only (e.g. emd.loss-from-physics, ped.operating-point-per-result-figure) |
| `lens.toml` | optional reading-lens procedure for `academia-read read --lens` (research-fit coordinates, contribution types, evidence ladder, transfer questions); its review questions are the field's criteria |
| `<content>/vocabulary/*.tsv`, `<content>/values.tsv` | optional field terms and values of dimensions a field owns |
