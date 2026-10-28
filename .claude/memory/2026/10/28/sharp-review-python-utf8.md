---
name: sharp-review-python-utf8
description: sharp-review runs ai-lab Python with PYTHONUTF8 so non-ASCII plans survive Windows
---
# sharp-review: ai-lab Python in UTF-8 (v4.2.3)

`sharp-review/scripts/lib/ai-lab.mjs` wraps spawnSync with `PYTHONUTF8=1`,
`PYTHONIOENCODING=utf-8`: on Windows the console code page (cp1252) made `ai_lab.review.plan`
die with UnicodeEncodeError on "≥". Takes effect after plugin auto-update.
