---
name: rem-scripts
description: Architecture of the rem plugin's scripts/ directory
metadata:
  type: reference
  doc_source: [rem/scripts/]
---

# rem/scripts — architecture (sample bound doc)

This is a **sample living doc** used to dogfood the doc-freshness system on the
cc-market repo itself. It is bound (via `doc_source`) to `rem/scripts/`, so it goes
stale when that subtree drifts past threshold from its **device-local anchor**
(`docs.anchors["<path>"].git_hash` in `.claude/.rem-state.json`) — the anchor is not
in this file's frontmatter.

## Modules

- `lib.mjs` — single source of truth for paths, dates, entries, derived visibility, the derived index.
- `task-engine.js` / `task-lib.mjs` — `/todo` engine + pure task logic.
- `merge-memory.js`, `crystallize.js`, `index-memory.js`, `scope-split.js` — memory lifecycle.

<!-- rem:manual -->
NOTE (human): this block must survive any automated refresh verbatim — it is the
annotation-preservation test. Do not rewrite or relocate it.
<!-- /rem:manual -->
