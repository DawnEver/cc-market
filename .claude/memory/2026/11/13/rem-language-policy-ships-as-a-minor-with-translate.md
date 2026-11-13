---
name: rem-language-policy-ships-as-a-minor-with-translate
description: User rulings 2026-11-13 on the rem English-only policy release
metadata:
  type: project
---

User rulings 2026-11-13 (user away, decision authority delegated): (1) the rem English-only writer policy ships as a MINOR release, not a patch -- it newly refuses text that used to be accepted; (2) kana and hangul stay in the English-only check alongside dev-lab's CJK ranges. Decided in the same session: task journals get exactly one sanctioned rewrite, `task.js translate --line <n> "<english line>"`; it requires a foreign-script line, a replacement with none, a byte-identical `- <date> <tag>: ` prefix, and appends a `progress: line <n> translated to English` audit line (an appended line rather than a trailing marker, so the rewritten line itself stays a clean translation and the journal stays parseable). The public-hygiene leak in the 2026-10-31 four-layers plan was already fixed on main by d44f28f.
