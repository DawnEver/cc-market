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

- `lib.mjs` — single source of truth for paths, dates, `_meta.json` I/O, index.
- `task-engine.js` / `task-lib.mjs` — `/todo` engine + pure task logic.
- `prune-memory.js`, `crystallize.js`, `scope-split.js` — memory lifecycle.

<!-- rem:manual -->
NOTE (human): this block must survive any automated refresh verbatim — it is the
annotation-preservation test. Do not rewrite or relocate it.
<!-- /rem:manual -->
