# Field writing profiles

Each profile records how one field writes: section moves with counts, slot templates of
recurring sentences, conventions, divergences from `../writing-style.md`, and weak patterns.
Built by the `field-reading` skill (rule 38) from full texts in the user's literature
corpus (`cc-academia` reviews), 2026-11-18. Counts are approximate.

| Profile | Field | Papers read | Reliability |
|---|---|---|---|
| `power-electronics-drives.md` | PWM losses, multiphase drives, co-simulation | 46 | sampled sections |
| `electrical-machine-design.md` | PM/IPM machine design and optimisation (ICEM, IEEE TEC/TIA) | 67 | mostly deep-read cards |
| `computational-mechanics-optimisation.md` | topology optimisation, isogeometric analysis, FEM | 35 | some PDFs extracted poorly |
| `music-information-retrieval.md` | MIR, audio ML (ISMIR, ICASSP) | 11 | small corpus, tentative |

## What all four fields share

All four fields keep the same section skeleton: context, specific problem, prior work, gap,
this paper, then findings. They differ in register and in where numbers go. Five practices
appear in every field and are looser than the generic rules. Under rule 38 a field profile
only tightens the rules, so each of the five is a pattern to avoid, and the rule holds.

1. Numbered contribution lists and "organized as follows" roadmaps (rules 7, 24, 25).
2. Announced novelty: "novel", "to the best of our knowledge" (rule 23).
3. ", which" tails, "while"/"although" contrasts, and "However" as the gap marker (rules 29, 36).
4. Personified subjects for papers, methods and models: "results reveal", "the model learns"
   (rules 26, 31).
5. Numbers in the abstract: "up to x %", often with the operating point (rule 15). This is
   strongest in IEEE Transactions and in MIR benchmark reporting.

The generic rules are therefore deliberately stricter than field practice. They aim at a
clear sentence, not at the field average. Field profiles add the moves and the venue
conventions; they never relax a rule.
