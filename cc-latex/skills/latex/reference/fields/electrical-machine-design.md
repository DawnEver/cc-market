# Field writing profile: electrical machine design

Scope: design, modelling and optimisation of PM, IPM, SynRM/PMaSynRM, induction and switched
reluctance machines for traction, aerospace and high-speed uses; conference digests and journal papers.

Corpus: 67 papers sampled (62 ICEM 2026 digests via deep-read cards with quoted abstract,
introduction, results and conclusion text; 5 full texts in IEEE Trans. Energy Conversion,
IEEE Trans. Industry Applications, SCEMS, MDPI Energies and MDPI Machines); years 2021-2026.
Three further optimisation/geometry full texts (CAD, mechanics) were read for contrast only.

Exemplary papers:
- Korman et al. 2022, IEEE TEC -- states the parametrisation trade-off in two plain sentences, then the remedy.
- Ban, Stipetic, Jercic 2021, Energies -- abstract runs context, cost of complexity, method, one number.
- Ban and Stipetic 2022, Machines -- honest limitation sentence inside the abstract.
- Chen et al. 2026, IEEE TIA -- abstract closes on prototype-backed relative improvements.
- Resch et al. 2026, ICEM -- gap stated as a specific physical omission of prior models.
- ICEM26-000406 (WIPM vs IPM, 2026, ICEM) -- gap narrowed through two prior comparisons to a fair-comparison need.
- ICEM26-000306 (asymmetric V/U rotors Part I, 2026, ICEM) -- explicit scope and deferred limitation.
- ICEM26-000675 (2L vs 3L supply of a bearingless PMSM, 2026, ICEM) -- one-sentence objective, one-sentence contribution.

## 1. Moves per section

### Abstract (100-200 words; conference 120-180, journal 150-250)
1. Application or trend context (rare-earth risk, power density, efficiency) -- 48/67.
2. Limitation of current practice (FEA cost, few-parameter shapes, isolated studies) -- 55/67.
3. "This paper proposes/presents" the method or machine -- 64/67.
4. Method detail: model type, tool, optimiser, surrogate -- 50/67.
5. Quantified headline result (percent change vs baseline) -- 41/67 (journal 5/5; digests ~36/62).
6. Validation statement (prototype test or FEA agreement) -- 30/67, more in journals.
7. Closing generalisation or design guideline -- 22/67.

### Introduction
1. Application demand opener citing review/market sources -- 58/67.
2. Candidate technology and its known benefit with citations -- 60/67.
3. Survey of prior approaches grouped by method, each with a drawback -- 57/67.
4. Gap: "However, ..." contrast naming what prior studies lack -- 61/67.
5. Purpose: "Therefore/In this paper ..." -- 64/67.
6. Contribution list, numbered (1)-(3) or "First ... Second ..." -- 24/67 (more in 2025-26 papers).
7. Roadmap paragraph by section -- 30/67 (rare in 4-page digests, standard in journals).

### Method / model
1. Machine specification table (geometry, ratings, materials) -- 52/67.
2. Topology or parametrisation figure with design variables -- 45/67.
3. Governing equations (loss models, scaling laws, constraints) with "where ..." -- 49/67.
4. Assumptions listed (2-D, infinite permeability, end-effect coefficient) -- 31/67.
5. Optimisation set-up: objectives, constraints, algorithm, population/generations -- 33/67 (all optimisation papers).
6. Fair-comparison constraints (equal envelope, PM volume, phase voltage, fill factor) -- 26/67.

### Results and discussion
1. Baseline vs proposed comparison at stated operating point -- 60/67.
2. Field plots/flux-density maps explaining the mechanism -- 40/67.
3. Sweeps or Pareto fronts with selected design marked -- 34/67.
4. Efficiency maps / drive-cycle energy -- 21/67 (traction papers).
5. Mechanical stress or rotordynamic check -- 25/67.
6. Experimental validation vs FEA with a percent discrepancy -- 22/67 (journals 4/5, digests ~18/62).
7. Limitation or caveat ("It should be noted that ...") -- 28/67.

### Conclusion
1. Restate what was proposed -- 60/67.
2. Findings as bullets or short paragraphs with relative numbers -- 50/67.
3. Mechanism or trade-off explanation -- 30/67.
4. Future work (prototype, thermal, experiments, fatigue) -- 38/67.

### Conference digest vs journal
- Digests (4-8 pages, ICEM/IEMDC/ECCE): introduction 3-5 paragraphs, 10-25 references, often no
  roadmap, validation often FEA-only, future work promises experiments.
- Journals: 30-60 references, explicit contribution list, prototype tests, sensitivity/robustness
  sections, nomenclature lists in some venues (MDPI, mechanics-adjacent).

## 2. Sentence templates

Abstract
- [Application] demands [property], which drives interest in [machine type].
- Conventional [method/shape] relies on [few parameters/simplification], which limits [freedom/accuracy].
- This paper presents [method] for [machine/component] based on [principle].
- The [method] is applied to [machine] and compared with [baseline] under [equal constraint].
- Compared with [baseline], [design] reduces [metric] by [x] % and raises [metric] by [y] %.
- A prototype is built and tested; measured [quantity] agrees with FEA within [x] %.
- The results give [designers] a basis for choosing [option] in [application].

Introduction: context and prior work
- [Machine type] is widely used in [application] owing to its [benefit] [refs].
- Reliance on [material] exposes [industry] to [risk], motivating [alternative] [refs].
- [Approach A] is accurate but costly in [time/computation] [ref].
- Analytical models of [phenomenon] are fast but neglect [effect] [ref].
- In [ref], [quantity] was reduced by [x] % through [measure].
- [Refs] studied [aspect] for [machine class] at [condition].

Introduction: gap and purpose
- These studies treat [aspect A] and [aspect B] separately; their combined effect on [metric] remains open.
- Prior comparisons used unequal [PM volume/envelope], so [effect] cannot be isolated.
- [Method] has been applied to [machine A]; its use in [machine B] is less documented.
- This paper investigates [question] for [machine] in [application].
- The objective is to determine how [factor] affects [metric] of [system].
- Section II describes [x]; Section III [y]; Section IV concludes.

Method / model
- The main specifications of [machine] are listed in Table [n].
- The [barrier/end] shape is defined by [n] control points, as shown in Fig. [n].
- [Loss] is computed from (n), where [symbol] is [definition].
- The following assumptions are made: [list].
- To ensure a fair comparison, [quantity] is kept equal for all designs.
- The optimisation minimises [objective] subject to [constraints], using [algorithm] with [population] individuals over [generations] generations.
- [Model] is replaced by a [surrogate] trained on [n] FEA samples.

Results and discussion
- Fig. [n] compares [quantity] of [design A] and [design B] at [operating point].
- [Design] yields [x] % lower [metric] than [baseline], owing to [mechanism].
- The reduction stems from [physical cause], visible in the flux-density map of Fig. [n].
- As [parameter] increases, [metric] rises until [value] and then saturates.
- The Pareto front in Fig. [n] shows a trade-off between [objective 1] and [objective 2].
- The selected design satisfies [constraint] with a margin of [x] %.
- Measured and simulated [quantity] differ by less than [x] %, attributed to [cause].
- It should be noted that [result] holds only under [condition].

Conclusion
- This paper has presented [method] for [machine] in [application].
- [Design] improves [metric] by [x] % relative to [baseline] at the cost of [penalty].
- The comparison indicates that [option] suits [use case], and [other option] suits [other case].
- Future work will address [thermal/fatigue/prototype] and [operating range].

## 3. Conventions

- Reporting verbs: present tense for this paper's content ("this paper proposes", "Fig. 5 shows");
  past tense for cited work ("[12] compared", "was shown in [14]"); "results show/indicate/reveal"
  dominant. "Demonstrate" is common in abstracts for validated claims.
- Hedging: light. "slightly", "approximately", "up to [x] %" (very common in abstracts, inflating
  best-case figures); "It should be noted that" is the standard caveat opener.
- Gaps: overwhelmingly "However, [prior work] [lacks/neglects/does not consider] ..."; a minority
  use "to the best of the authors' knowledge, ... has not been ..."; strongest papers name the
  physical effect or the unfair comparison condition omitted by prior work.
- Numbers: journal abstracts carry 1-3 percentages (often to two decimals); digests often give
  one headline percent; operating points and absolute values appear mainly in results.
- Prior-work comparison: by citation number ("[12] compares ..."), rarely by author name;
  quantitative comparison with prior results is rare; comparison is with an in-paper baseline design.
- Figures/tables: "Fig. 3" mid-sentence, "Table I" Roman numerals (IEEE); "as shown in Fig. n"
  very frequent; captions short, descriptive nouns.
- Symbols: italic quantities with subscripts (T_ph, D_si, K_h); units in text with a space;
  speeds in r/min, rpm and krpm all occur; acronyms defined at first use in abstract and again in text.
- Abstract length: 120-250 words, single paragraph; keywords line in IEEE conference format.
- First person: "we" rare (under 10 %); "the authors" in acknowledgements and novelty claims.
- Equipment and software named freely (JMAG, Motor-CAD, ANSYS, KISSsoft) in method and acknowledgements.

## 4. Divergences from cc-latex rules (report only)

- Rule 23: novelty is announced in most papers ("novel" in title/abstract, "main contributions
  are", "for the first time", "to the best of the authors' knowledge").
- Rule 15 / project-adjusted abstract rule: abstracts routinely carry percentages and best-case
  "up to" figures; some carry operating speeds and power ratings.
- Rule 7 and 24: numbered contribution lists and multi-sentence roadmaps are common; structure
  previews "First, ... Then, ..." appear inside sections (also rule 25).
- Rule 29 and 31: ", which ..." tails and "that/which" relative clauses on nouns are pervasive.
- Rule 36: "While/Although X, Y" contrasts and ", however," mid-sentence are the default gap device.
- Rule 26: personified subjects are standard ("the paper proposes", "results reveal",
  "the method enables", "studies report").
- Rule 22: nested "in which / so that" and long multi-clause sentences are common, especially
  in method descriptions.
- Rule 19: textbook models (Bertotti/Steinmetz loss formulas, critical-speed rules) are restated
  in full with definitions instead of cited.
- Rule 2: evaluative adjectives ("comprehensive", "significant promise", "exceptionally low",
  "advanced") are frequent.
- Rule 17: "this work" and "this study" alternate with "this paper" within one paper.
- Rule 4: synonym variation for the machine (motor/machine/e-machine) is common.
- Rule 6: obligation voice for trends ("must be considered", "require") is common in context moves.

## 5. Weak patterns to avoid

- Abstract opener announcing importance with no object ("X is a fundamental aspect of design").
- Gap claims of total absence ("has not been conducted") contradicted by the paper's own citations.
- "Up to [x] %" headline numbers drawn from the best of many points with no operating point given.
- Unequal-constraint comparisons (different PM volume, envelope or voltage) reported as design gains.
- Text numbers disagreeing with figures or tables (percentages, strip counts, units such as 95.0 with no "%").
- Broken cross-references and mistyped speeds in titles surviving to print.
- "Error" for a difference between two models with no reference truth.
- Contribution lists repeating the abstract word for word.
- Single-word "However" opening three or more consecutive paragraphs.
- Future-work sentences that only promise "experimental validation" with no scope.
- Limitations hidden in method text instead of stated once in discussion or conclusion.
- Generic closing claims ("provides a valuable starting point") with no named design decision.
