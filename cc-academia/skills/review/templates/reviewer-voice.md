# Reviewer Voice — Style Profile

This is the house style for reviewer responses. Every draft and final output should read like a real reviewer wrote it — concise, direct, numbered, and actionable. No academic fluff, no passive hedging, no `[placeholder]` tone.

## Structure

- **Opening**: One of these patterns, chosen per paper:
  - A 1-2 sentence "General Comments" or "The main contribution is..." framing paragraph, then numbered points.
  - Jump straight into "Below are the detailed comments:" followed by numbered points.
  - No rigid template — vary naturally.

- **Numbered points**: Every critique is a numbered item. 2-5 sentences each. Self-contained — a reader can jump to point 4 and understand it without reading 1-3.

- **Typos**: Last numbered point(s). Specific: "Page 7: 'in accuracy' → 'inaccuracy'."

- **Recommendation**: Final line. One of: Accept / Minor Revision / Major Revision / Reject. No explanation needed — the points above are the explanation.

## Tone

- **Direct address**: "The authors should...", "Please provide...", "The manuscript would benefit from...", "I suggest..."
- **Active voice**: "Report the mesh element count" not "It is recommended that the mesh element count be reported."
- **Occasional first-person**: "I have some concerns about...", "I suggest..." — sparingly, 1-2 times per review max, keeps it human.
- **No severity labels**: Don't write "Major:" or "Minor:" prefixes. Order points from most to least important; the sequence conveys severity. The reader feels it, doesn't need to be told.
- **No academic hedging**: Avoid "It could be argued that...", "One might consider...", "It is perhaps worth noting...". Say it straight: "The down-scaling is not validated." Not "It may be the case that the down-scaling methodology has not been fully validated."

## Content rules

- **Every point is actionable**: The authors should know exactly what to DO after reading each point. "Add a mesh convergence study showing <0.5% efficiency change" not "Mesh convergence is inadequate."
- **Evidence is implicit**: Weave the evidence into the point naturally — "Table 2 shows 69.3% vs 70.6% on Artemis, a 1.3 pp gap" rather than a separate "Evidence:" line.
- **No cross-references to internal pipeline**: Never mention "angle A", "reviewer B", "cross-angle corroboration". These are internal scaffolding. The final review stands on its own.
- **Typos are specific**: Page number, wrong text, correction. Not "there are several typos throughout."

## Length

- 6-20 numbered points total, depending on paper severity.
- If the paper is strong: 6-10 points, mostly minor.
- If the paper needs major revision: 10-20 points, front-loaded with the big issues.
- Recommendation line doesn't count toward point total.
