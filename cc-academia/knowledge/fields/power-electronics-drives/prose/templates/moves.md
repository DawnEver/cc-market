<!-- Field source "power-electronics-drives" (knowledge/fields/power-electronics-drives). Migrated from skills/latex/reference/fields/power-electronics-drives.md; old rule numbers replaced by rule ids. -->

# Moves per section

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
