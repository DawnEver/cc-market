# Field writing profile: power electronics and drives (PWM losses, multiphase machines, co-simulation)

Scope: journal and conference papers on PWM-induced machine losses, multiphase (dual three-phase) PMSM drives,
carrier phase shift and interleaving, and inverter-machine field-circuit co-simulation.

Corpus: 46 papers sampled (abstract, introduction opening, one results passage, conclusion); IEEE Trans. (PE, IA, IE,
Magn., EC, TE), IEEE JESTPE, IET EPA, IEEE conferences (ECCE, IEMDC, IPEC, INTERMAG, IPEMC), MDPI journals, IEEJ,
Elsevier JESTCH; 2008-2026. Counts below ("n/46") are tallies from the sampled sections, accurate to about +/-3.
Models of good writing:
- Yamazaki and Abe 2009, IEEE TIA: short abstract ending on one physical, transferable design rule.
- Zhu, Hua and Shi 2021, IEEE Trans. Magn.: one comparison, one causal argument, one quantified conclusion.
- Liu, Mi and Gao 2008, IEEE Trans. Magn.: parameter-by-parameter effect statements, checked by FEA and test.
- Wang et al. 2020, IEEE TPEL: clean gap-to-method chain; each case tied to a measured reduction.
- Zheng et al. 2024, IEEE TPEL: mechanism stated as a claim, numbered findings in the conclusion.
- Balamurali et al. 2021, IEEE TIA: loss model leading to a control decision; layered validation.
- Ragazzo et al. 2024, IEEE conference: thermal motivation, correction factors with signed sizes.
- Chen et al. 2026, IEEE TTE: application-first abstract, before/after numbers at a named operating point.

## 1. Moves per section

Abstract (median about 170 words; IEEE Trans. 150-250, conferences 100-170, no citations):
1. Application or technology context (PWM drives, EV traction, multiphase merits) - 34/46.
2. Problem: PWM harmonics add loss, ripple, heating or DC-link stress - 38/46.
3. Gap or limitation of existing methods (slow, inaccurate, neglects an effect), often one clause - 27/46.
4. "This paper/article proposes/presents/investigates" plus the method - 46/46.
5. Method detail (model, tool, transformation, case machine) - 36/46.
6. Validation means (FEA, simulation, experiment on a prototype) - 40/46.
7. Quantified result (percent reduction, error bound, time saving) - 24/46; common in IEEE Trans. and MDPI,
   rare in magnetics and conference abstracts.
8. Implication or design guidance - 17/46.

Introduction:
1. Broad application context with a citation cluster ([1]-[4]) - 43/46.
2. Machine or drive class and its merits (PMSM/IPMSM, multiphase, DTP) - 40/46.
3. Problem mechanism (carrier harmonics -> current ripple -> loss, torque ripple, EMI) - 39/46.
4. Literature walk grouped by approach (analytical, FEA, co-simulation; or control family), with [n]-[m] ranges
   and often one sentence per cited work - 41/46.
5. Gap ("However", "few studies", "neglects", "has not been") - 38/46.
6. Purpose: "In this paper/article, ..." with the method - 44/46.
7. Enumerated contribution list - 17/46 (mostly IEEE Trans. after 2020).
8. Roadmap paragraph - 22/46.

Method or model:
1. System description with a topology or control figure (inverter, two winding sets, VSD planes) - 41/46.
2. Equations derived or cited (double Fourier integral, VSD matrix, loss model) - 40/46.
3. Assumptions stated (linear modulation, constant parameters, neglected end effects) - 30/46.
4. Machine and test parameter table - 37/46.
5. Simulation settings (time step, mesh, coupling scheme) - 21/46, mainly FEA papers.

Results and discussion:
1. Operating point stated first (speed, torque or current, Vdc, fc, M) - 42/46.
2. Waveform, then spectrum, with harmonic groups named around fc and 2fc - 33/46.
3. Comparison with a baseline (sinusoidal supply, conventional PWM, three-phase counterpart, other model) - 44/46.
4. Quantified difference (percent, W, relative discrepancy) - 44/46.
5. Physical explanation of the difference - 35/46.
6. Check against measurement with the discrepancy and its cause - 27/46.
7. Limits or sensitivity (load, frequency, saturation) - 18/46.

Conclusion:
1. Recap of what was proposed or investigated (present perfect or past) - 45/46.
2. Key findings, numbered 1)-n) in 14/46 - 39/46.
3. Headline numbers repeated from the results - 26/46.
4. Validation statement - 31/46.
5. Limitation and future work - 21/46.
6. Closing recommendation or generalisation - 15/46.

## 2. Sentence templates

Context
- [Machine class] is widely used in [application] because of its [merit] and [merit] [refs].
- [Machine class] is usually supplied by [converter type] to control [quantity] over a wide [range].
- [Configuration] offers [merit] over [baseline], so it suits [application] [refs].
- The trend towards [design trend] lowers [parameter] and hence raises [ripple or loss quantity] [ref].
Problem
- The [harmonic type] produced by [source] induces additional [loss component] in [part].
- [Loss component] is small relative to [total]; it still limits [rating] because [thermal reason].
- In [multiphase machine], [harmonic component] maps onto [plane], where only [impedance] limits the current.
Literature and gap
- [Method class] has been applied to [problem] [refs], and [variant] extends it to [condition] [ref].
- The study in [ref] computed [quantity] with [method] and reported [finding].
- These methods take [quantity] as [input type]; [effect] at [condition] is therefore neglected.
- Prior studies of [quantity] covered [case A] and [case B] [refs]; [case C] was outside their scope.
- [Approach] is accurate, but its computation time restricts it to [few points / task].
Purpose and contribution
- This paper [investigates/proposes] [method] to [compute/reduce] [quantity] in [machine] under [supply].
- The [model] is checked against [FEA type] and against measurements on a [rating] prototype.
- The contributions are: 1) [model]; 2) [mechanism or analysis]; 3) [validation or guideline].
Method
- The [quantity] is expressed with the [transformation or integral] [ref] as (n).
- [Plane or component] contains only [parameters]; therefore [consequence for the current].
- The [model] assumes [assumption], valid when [condition].
- The [field solver] is coupled with the [circuit or control model], and [inverter] imposes the winding voltage.
- Table [n] lists the parameters of the studied machine.
Results
- Fig. [n] shows the [waveform] at [operating point]; its spectrum contains sidebands around [fc] and [2fc].
- Compared with [baseline], [method] reduces [quantity] by [x] % at [operating point].
- [Quantity] from [method A] is [x] % lower than from [method B] because [mechanism].
- [Quantity] increases with [parameter] since [mechanism] and levels off above [threshold].
- The discrepancy between [model] and [reference] stays within [x] % over [range].
- At high [frequency], [effect] limits [quantity]; neglecting it overestimates [loss] by [x] %.
- [Quantity] measured and calculated agree within [x] %, except at [condition], where [cause] dominates.
- Computation time falls from [t1] to [t2] for a deviation below [x] %.
Conclusion
- This paper has [proposed/investigated] [method] for [quantity] in [machine class] fed by [converter].
- [Quantity] is mainly produced by [source]; [design variable] should be [rule] to reduce it.
- [Method] reduces [quantity] by [x] % relative to [baseline] without [penalty].
- Future work will extend the analysis to [condition] and [component].

## 3. Conventions

- Self-reference: "this paper" (conferences, MDPI) and "this article" (IEEE Trans. since about 2020, house style);
  "this work" or "this study" in about 12/46; first person "we" in about 8/46 (industrial authors, some IEEE TIA).
- Tense: cited methods in present ("[n] proposes"), cited findings in past ("[n] reported"); own method in present
  passive ("is derived", "is proposed"); own results in present or past; conclusions in present perfect.
- Hedging: weak. Findings are asserted ("is proved", "is verified", "effectively suppresses", "significantly");
  "may" and "can" appear mainly in motivation. "Novel", "superior", "accurate" are frequent self-descriptions.
- Gap strength: from soft ("few studies", "has not been well discussed") to absolute ("remains lacking", "has not
  been reported nor compared yet"); "However" opens the gap sentence in about 30/46.
- Numbers: IEEE Trans. and MDPI abstracts give 1-3 headline numbers (percent reduction, error bound, rating,
  sometimes the operating point); magnetics and conference abstracts give none. Results attach the full operating
  point (r/min, N.m or A, Vdc, fc, M) to every figure.
- Prior work is compared method against baseline inside the same paper ("compared with conventional SVPWM",
  "with reference to the transient solver"); numeric comparison with another paper's values is rare.
- Figures and tables: "Fig. 7(a) shows", "as shown in Fig. 5", "listed in Table II" (IEEE); "Figure 7" (MDPI);
  equations cited as "(12)".
- Nomenclature: IEEE Trans. control papers often carry a NOMENCLATURE block (6/46). Acronyms are dense (VSI, SVPWM,
  CPS-PWM, VSD, THD, TSFEA) and paper-specific coinages are frequent; subspace names vary (xy, z1z2, Z1Z2).
- Symbols: fc, f0 or f1, M for modulation index, theta_c for carrier phase; sidebands "fc +/- 2f0", "2fc +/- f0".
  Speed units: r/min (IEEE) versus rpm or min^-1 (others).
- Validation hierarchy expected: analytical -> 2D FEA -> (3D FEA) -> experiment; papers without tests say so and
  defer them to future work.

## 4. Divergences from cc-latex rules 1-37 (reported, not resolved)

- Rule 15 (detail follows position): 24/46 abstracts and 26/46 conclusions give percent or absolute numbers, some with
  operating points; IEEE Trans. control papers expect them. The field is looser.
- Rule 17 ("this paper"): IEEE Trans. house style is "this article"; the field mixes "work", "study", "we".
- Rules 7 and 24 (no enumerative scaffolding): enumerated contribution lists (17/46) and numbered conclusion findings
  (14/46) are standard in IEEE Trans.
- Rule 18 (open broad, narrow by one level): 12/46 abstracts open on the method ("This paper presents ...").
- Rule 19 (cite textbook material): about 30/46 papers re-derive VSD matrices, double Fourier integrals or MTPA equations.
- Rule 16 (no coined terms): paper-specific acronyms for single concepts are common and tolerated.
- Rule 23 (no announced novelty): "novel" or "main contribution and novelty" appear in about 20/46.
- Rules 29, 31, 36 (no relative tails, no "that/which" on nouns, no "while/although/but" contrasts, no "whereas"):
  ", which ..." tails and "while" contrasts occur in almost every paper; "whereas" in about 10/46.
- Rules 26 and 31 (no personified verbs): "the machine suffers from", "the strategy seeks", "enables" are routine.
- Rule 2 (plain wording): "of paramount importance", "imperative", "remarkable" occur.
- Rule 14 (tables): parameter tables usually abbreviate names and pack two quantities ("slots/poles") in one cell.
- Stricter in the field: every result figure carries its operating point, and FEA plus measurement is the expected
  validation; cc-latex has no rule requiring either.

## 5. Weak patterns to avoid

- Abstracts that list tasks ("is investigated ... is compared ... is discussed") with no finding.
- Absolute gap claims ("has never been studied") without evidence; state what prior work covered instead.
- One-sentence-per-reference literature walks with no grouping or link to the gap.
- Superlatives without numbers ("superior", "significantly improves", "highly accurate").
- "Error" for a difference between two models with no reference truth.
- Conclusions that restate the abstract or the method steps instead of findings.
- Percent changes given without the baseline or the operating point.
- Acronyms coined for single-use concepts; several names for one plane within one paper.
- Long sentences chaining premise, mechanism and numeric result with "which" and "thereby".
- Future work as "will be studied in the future" without naming the condition or component.
- Re-derived textbook transforms taking space from the paper's own mechanism.
- Validation by visual waveform similarity ("agree well") without a quantified discrepancy.
