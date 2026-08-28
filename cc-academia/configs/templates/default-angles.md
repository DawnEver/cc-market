# Default critique angles

Compact default set — four angles. Each maps to one reviewer agent under `.claude/agents/`. The angle gate (step 03) presents these plus high-hit-count library angles; the user adds, removes, or customises before fanout.

### novelty
Novelty + related-work coverage. Decide whether each claimed contribution is genuinely new given what the paper cites — and what it omits.

Look for:
- Contributions that are framing-level rather than substantive.
- Cited prior work that already does the thing the paper presents as new.
- "First to do X" claims that fail a quick web check.
- Mischaracterised baselines.

### methodology
Methodological rigor + reproducibility. Probe for hidden assumptions, proof gaps, definitional sloppiness — and for missing code, data, hyperparameters, seeds.

Look for:
- Theorems that prove Y while the prose claims X.
- Required assumptions stated nowhere.
- Hyperparameters absent or only listed for the best run.
- Vague training/eval protocol; no variance, no seeds.

### experiments
Experimental adequacy + data distributions + figure/writing quality. The vision-capable angle. Inspect every figure, compare prose to tables, scrutinise distributions.

Look for:
- Missing baselines, cherry-picked benchmarks, single-seed runs.
- Ablations that don't isolate the headline claim.
- Tables and prose that disagree.
- Distribution shape hidden behind means — skew, multimodality, outliers that change the story.
- Wrong summary statistic for the distribution, error bar ambiguity (SD vs SEM vs CI).
- Statistical test mismatch, sample size too small for the claim.
- Missing distribution plots (histograms, violins, box plots) when only bar charts are shown.
- Truncated axes, missing error bars, captions that overclaim.

### freestyle
Wildcard. Invent a fresh angle the three above do not cover, tailored to **this** paper.

Examples (not a menu — pick something this paper specifically invites):
- Ethics / societal impact
- Scaling claims realism
- Applicability to real workloads
- Dataset bias / demographic skew
- Compute economics — gain per GPU-dollar
- Failure-mode coverage — what is conveniently untested?

If no fresh angle exists, the freestyle agent is permitted to say so and stop. Do not pad.
