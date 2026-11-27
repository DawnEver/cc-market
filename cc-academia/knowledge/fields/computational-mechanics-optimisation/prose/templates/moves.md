<!-- Field source "computational-mechanics-optimisation" (knowledge/fields/computational-mechanics-optimisation). Migrated from skills/latex/reference/fields/computational-mechanics-optimisation.md; old rule numbers replaced by rule ids. -->

# Moves per section

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
