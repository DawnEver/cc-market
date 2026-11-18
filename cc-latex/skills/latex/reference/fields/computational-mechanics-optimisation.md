# Field writing profile: computational mechanics and computational electromagnetics (topology optimisation, IGA, FEM)

Scope: method papers that propose or extend a discretisation or optimisation scheme and demonstrate it on numerical examples, often on electric-machine geometries.

Corpus: 35 papers read (23 topology-optimisation full texts, 12 isogeometric-analysis PDFs); venues IEEE Trans. Ind. Electron., IEEE Trans. Magn., IEEE Trans. Energy Convers., IEEE Trans. Ind. Appl., IEEE conferences (ICEMS, ECCE, CEFC), CMAME, J. Comput. Phys., SIAM J. Sci. Comput., Springer computational-mathematics journals, arXiv preprints; 2011-2026.

Exemplary papers (models of good writing):
- Buffa et al. 2014, J. Comput. Phys. -- abstract moves from object to theory to extension to tests in four clean steps.
- Bontinck et al. 2018, CMAME -- states the accuracy argument (exact air-gap arcs) before the method.
- Kapidani et al. 2024, Springer journal -- gap, impasse, remedy and insight in a tight abstract.
- Elbadry et al. 2025, preprint -- three method variants compared on a graded benchmark ladder.
- Magneto-structural SIMP rotor papers 2020-2023, IEEE Trans. Ind. Appl. / Energy Convers. -- precise contribution paragraph and template-versus-TO comparison.
- Space-time air-gap element paper 2025, Springer -- ordered method abstract with an explicitly scoped originality.
- Topological-derivative thermal-constraint paper 2023, journal -- conclusion lists what was built, then an honest outlook.
- Interpolation-stability paper 2024, IEEE conference -- one hypothesis, one test, one finding.

## 1. Moves per section

Abstract (30 abstracts recovered):
1. Context or limitation of the conventional approach (parametric template, classical FEM) -- 21/30.
2. "This paper/article/work proposes/presents ..." with the method named by family (SIMP, level set, IGA, mortar) -- 29/30.
3. Key ingredients (coupling, interpolation, adjoint sensitivity, solver such as MMA/GCMMA) -- 26/30.
4. Demonstration vehicle ("a PMSM / SynRM rotor serves as example") -- 24/30.
5. Comparison claim versus template-based design or classical FEM -- 17/30; numbers in about 10/30 (IEEE application papers, percentages); mathematics venues give none.

Introduction:
1. Field importance (EV traction, CAD-analysis gap) -- 30/35.
2. Literature survey by method family, citation-dense, "X was proposed in [n]" -- 33/35.
3. Gap as a limitation of the prior family ("requires a geometric template", "requires remeshing") -- 31/35; explicit "has not been" claims 3/35; "first" or "to the best of our knowledge" 5/35.
4. Contribution: "The contribution of this article is ..." or "In this work, we ..." -- 30/35.
5. Roadmap paragraph "The rest of this article is organized as follows" -- 25/35, one clause per section.

Formulation/method:
1. Governing equations first (magnetostatic or eddy-current Maxwell system, linear elasticity), numbered, then weak form -- 32/35.
2. Discretisation (FE/NURBS spaces, SIMP power-law interpolation) introduced with "is given by / is defined as / can be written as", then a "where ..." symbol list -- nearly all.
3. Optimisation problem as a stacked min / s.t. display with constraints g1..gn -- 20/23 TO papers.
4. Sensitivity analysis (adjoint variable method, chain rule) -- 18/23 TO papers.
5. Filtering, projection or regularisation and solver update -- 16/23.
6. Algorithm box or flowchart -- 14/35.

Numerical examples / results:
1. Set-up: geometry, materials, mesh, operating point, usually in a table -- 33/35.
2. IGA/FEM papers: convergence study (error versus DOF or h, rates per degree p) against an analytical or overkill reference -- 10/12.
3. TO papers: optimised layouts per formulation or weight, plus convergence history of objective and constraints -- 20/23.
4. Comparison with classical FEM (accuracy per DOF, run time) or with a template optimum (torque, ripple, stress) -- 27/35.
5. Verification: re-mesh and post-process the optimum, sometimes prototype and test -- 9/23 TO papers.
6. A reading sentence after each figure ("It can be seen that ..."), often descriptive rather than causal.

Conclusion:
1. Restatement "This paper presented/demonstrated ..." -- 33/35.
2. Two to four findings, with numbers mostly in IEEE papers -- 25/35.
3. Limitations and future work, often headed "Conclusions and outlook" -- 22/35.

## 2. Sentence templates (slots in brackets)

Context and gap:
- [Design task] conventionally relies on [template / parameterisation], which restricts the result to [shape class].
- [Method family] has been applied to [object] in [refs], mainly for [objective].
- These approaches require [costly step: remeshing / mesh deformation / dual mesh] when [condition].
- A remedy for [impasse] is to [augment / couple / project] [space or field] with [ingredient].
- Accurate [quantity] depends on [geometric feature], which [classical method] represents only approximately.

Purpose and contribution:
- This [paper] proposes a [adjective] [method] for [object] based on [ingredient].
- The contribution of this [article] is [method] with [property] and without [costly step].
- In this work, we [adopt / extend / evaluate] [technique] for [new setting].
- The aim is to [improve objective] with [constraint quantity] kept below [limit].
- Compared with [ref], the present formulation additionally accounts for [effect].

Roadmap:
- Section [n] introduces [governing problem]; Section [m] derives [sensitivities]; Section [k] reports [examples].

Equations:
- On [domain], the [field] satisfies [equation (n)], where [symbol] denotes [meaning].
- The [material property] of element [k] is interpolated as [eq], where [p] is the penalisation exponent.
- The optimisation problem reads [stacked display].
- Applying the adjoint method to [eq] gives the sensitivity [eq].
- Substituting [eq a] into [eq b] yields [result].

Numerical set-up:
- The method is tested on [benchmark / machine] with the data of Table [n].
- The reference solution comes from [overkill mesh / analytical expression].
- All runs use [solver / hardware / thread count] for an equal timing comparison.

Results:
- Fig. [n] shows [error measure] versus [DOF / h] for degrees [p].
- The error decreases at rate [r], in agreement with [theory / ref].
- For the same [DOF / torque], [method A] gives [lower error / lower stress] than [method B].
- The optimised layout forms [feature]; [feature] [raises / lowers] [objective] through [physical effect].
- Without [constraint], the optimiser produces [infeasible feature]; adding [constraint] removes it.
- The objective converges within [n] iterations with all constraints satisfied.
- Relative to [baseline], [quantity] changes by [x] % at [condition].

Conclusion:
- This paper presented [method] for [object] and demonstrated it on [example].
- The results show [main finding with direction or number].
- The approach [avoids / reduces] [cost] because of [mechanism].
- Future work will address [extension 1] and [extension 2].

## 3. Conventions

- Reporting verbs: propose, present, develop, introduce, derive, demonstrate, validate, compare; results "show / indicate / reveal".
- Tense: present for method and figures; past or present perfect in conclusions.
- Person: "we" in all mathematics/IGA papers and about 60 % of IEEE TO papers; passive ("is employed", "is used") for set-up.
- Hedging: light ("can", "may"); strength comes from comparisons, not adverbs.
- Gap statements: mostly a limitation of a named method family; explicit "not studied" claims are rare (3/35).
- Numbers: none in mathematics-venue abstracts; one or two percentages in IEEE application abstracts; results sections carry tables of torque, ripple, stress, error, DOF and CPU time.
- Comparison with prior methods: "the proposed method" versus "a geometric template-based optimisation" or "classical FEM", with fairness conditions stated (same DOF, same torque, single thread).
- Equations: numbered, punctuated as part of the sentence, followed by a "where" list; vectors bold; curl, div, grad roman; material densities rho with per-material subscripts.
- Figures: "Fig. [n] shows ..." or "(see Fig. [n])"; "Section II" (IEEE) versus "Section 2" (journals).
- Acronyms defined in the abstract and again at first use: SIMP, MMA, GCMMA, IGA, NURBS, DOF, TO.

## 4. Divergences from cc-latex rules 1-37 (report only)

- Rules 7, 24, 25: a full roadmap paragraph (25/35), "first / then / finally" step lists in abstracts, and section openers "In this section, ...".
- Rules 15, 18: abstracts often open with the method limitation, not the broadest context; IEEE abstracts carry numbers.
- Rule 17: "this article", "this work" and "this contribution" are as common as "this paper".
- Rule 23: novelty is announced ("The contribution of this article is", "novel" in 18/35, "originality", "first application").
- Rules 26, 31: method agents are personified routinely ("the optimiser finds", "the method ensures", "the algorithm returns").
- Rules 29, 31: ", which" tails and "that" relatives are pervasive (about 18 "which" per paper).
- Rule 36 and the project "However"/"whereas" bans: "However" in 32/35 papers, "whereas" in 10/35, "while" joins contrasts throughout.
- Rule 27: prose after a display usually continues the paragraph beyond the "where" list.
- Rule 30: log-log convergence plots are standard (falls under "unavoidable"); objective histories use linear axes.

## 5. Weak patterns to avoid

- Abstracts listing steps ("First ..., then ..., finally ...") without saying what was found.
- "A validation example proves the effectiveness" with no measure of effectiveness.
- "It can be seen that" followed by a restatement of the figure rather than a cause.
- "First" or "novel" claims without a stated comparison.
- Conclusions restating the method with no quantitative finding or limitation.
- Comparisons at unequal DOF, mesh or run conditions, or against an unstated reference solution.
- Convergence claims without a rate, a reference solution or a norm.
- Optimised layouts shown without a check on a re-meshed, post-processed model.
- Long sentences mixing set-up, result and interpretation; strings of acronyms in one clause.
