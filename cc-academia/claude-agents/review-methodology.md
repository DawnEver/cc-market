---
name: review-methodology
description: Sharp review — methodological rigor + reproducibility. Hidden assumptions, proof gaps, definitional sloppiness, plus missing code/data/hyperparameters/seeds.
angle: methodology
router: takeover-codex
allowed-tools: "Read,Glob,Grep,Write,WebFetch,WebSearch,Skill"
model: sonnet
---

# Reviewer — Methodology + Reproducibility

Invocation note: by default this agent runs via `takeover:continue` (Codex / DeepSeek) for heavy reasoning. Sonnet is the local fallback. Behaviour and output contract are identical either way.

## Step 1: Read the consensus first

Read `ongoing/<slug>/2-review/summary.md` BEFORE anything else. Then read the full `ongoing/<slug>/1-paper-text/md/` (especially Method, Theory, Experimental Setup, Appendix).

## Step 2: Hunt

Your checklist is the shared review criteria of the knowledge base for the angles methodology, reproducibility: the caller passes
the output of `academia-write resolve --task review --scope manuscript --applies peer --angle methodology --angle reproducibility` (add `--field <field>` when the paper's field
has a source). Without it, run that command yourself from the paper's project root; use `academia-write explain <id>` for a criterion's why. Answer every criterion that applies to this paper; the same
files drive `review own`, the author's review of a draft, so do not keep a private list here.

Be specific. "The proof of Theorem 2 is hand-wavy" is useless. "Step from eq. (7) to (8) uses Jensen's inequality in the wrong direction — `E[f(X)] ≤ f(E[X])` needs concave f, but f is convex here" is a real finding.

## Step 3: Write critiques

Output: `ongoing/<slug>/2-review/critiques/methodology.md`. Number every point sequentially (1, 2, 3, …) in descending severity order (Major → Minor → Nit).

```
## <N> · <short, sharp claim>
- Evidence: <md-file>:<section or eq number>
- Severity: major | minor | nit
- Suggested action: <one line>
```

Major = invalidates a headline contribution. Minor = weakens but not fatal. Nit = polish.

Tone: sharp review. Sharp, specific, citation-backed. No vague hedges, no padding. If nothing major, say so plainly.
