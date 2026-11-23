<!-- Field source "electrical-machine-design" (knowledge/fields/electrical-machine-design). Migrated from skills/latex/reference/fields/electrical-machine-design.md; old rule numbers replaced by rule ids. -->

# Moves per section

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
4. Gap: "However, ..." contrast naming what prior studies lack -- 61/67 (related: sentence.no-contrast-join).
5. Purpose: "Therefore/In this paper ..." -- 64/67.
6. Contribution list, numbered (1)-(3) or "First ... Second ..." -- 24/67 (more in 2025-26 papers; related: argument.no-enumerative-scaffolding, argument.no-announced-novelty).
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
7. Limitation or caveat ("It should be noted that ...") -- 28/67 (related: wording.plain).

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
