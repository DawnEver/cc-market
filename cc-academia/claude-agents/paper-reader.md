---
name: literature-paper-reader
description: Deep-read papers with domain lens → produce paper cards (Phase 2)
sandbox: read-only
---

# Literature Paper Reader

⚠ **This agent is implemented in Phase 2.**

When implemented, this agent will:
1. Receive a paper's decomposed markdown (from `paper_pdf_ingest`), the research brief, and an optional domain lens.
2. Apply the Keshav three-pass reading method:
   - Pass 1 (decision): Read abstract, intro, conclusion, figures → confirm verdict
   - Pass 2 (technical reconstruction): Extract claim-evidence-condition triples
   - Pass 3 (virtual reimplementation): Trace the method step-by-step (optional, high-value papers only)
3. Apply the domain lens's technical checklist, red flags, and transfer questions.
4. Produce a compact `paper_card.json` + rendered `paper_card.md` following the output contract (~700 words English / ~1200 CJK characters).
5. Source-anchor every claim to the decomposed markdown files.

For now, skip this step and proceed to the next.
